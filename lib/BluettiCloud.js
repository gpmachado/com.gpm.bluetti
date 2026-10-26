'use strict';

// BLUETTI cloud client.
// Endpoints, headers and OAuth client come from the official Home Assistant integration
// (github.com/bluetti-official/bluetti-home-assistant) and were confirmed against a real
// Elite 30 V2 by the ioBroker.bluetti adapter.

const https = require('https');
const { env } = require('homey');

const SSO_URL = 'https://sso.bluettipower.com';
const GATEWAY_URL = 'https://gw.bluettipower.com';

// OAuth client and app key from BLUETTI's official Home Assistant integration (MIT,
// custom_components/bluetti/profile/application.yaml). Kept in env.json, see env.json.dist.
const CLIENT_ID = 'HomeAssistant';
const { BLUETTI_CLIENT_SECRET: CLIENT_SECRET, BLUETTI_APP_KEY: APP_KEY } = env;
// The real-time gateway rejects older client versions with code 600 "Upgrade required".
const APP_VER = '1.0.5';

// Homey's fixed OAuth2 callback; BLUETTI does not restrict redirect URIs for this client.
const REDIRECT_URI = 'https://callback.athom.com/oauth2/callback';

const API_PREFIX = '/api/bluiotdata';
// 803 = invalid access token, 805 = expired access token.
const TOKEN_ERROR_CODES = new Set([803, 805]);
const REQUEST_TIMEOUT_MS = 15000;
// OAuth errors that mean the login itself is gone. Anything else (server_error, a 5xx JSON body
// with an "error" field, ...) is temporary and must not wipe the stored token.
const OAUTH_AUTH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
const SETTINGS_KEY = 'oauth_token';

class BluettiAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BluettiAuthError';
  }
}

class BluettiApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BluettiApiError';
    this.code = code;
  }
}

// Minimal JSON-over-HTTPS helper. Node's global fetch loads undici, which costs
// ~40 MB of extra memory per app process; the core https module does not.
function httpJson(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = https.request(url, {
      method,
      headers: payload ? { ...headers, 'Content-Length': payload.length } : headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          // non-JSON body
        }
        const status = res.statusCode;
        resolve({ status, ok: status >= 200 && status < 300, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('BLUETTI request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class BluettiCloud {

  constructor({ homey, log, onTokenChanged }) {
    this.homey = homey;
    this.onTokenChanged = onTokenChanged || (() => {});
    this.log = log;
    this._refreshing = null;
  }

  // ── Token storage ──────────────────────────────────────────────────────────

  getToken() {
    return this.homey.settings.get(SETTINGS_KEY) || null;
  }

  hasToken() {
    const token = this.getToken();
    return Boolean(token && token.access_token);
  }

  _saveToken(raw) {
    const now = Date.now();
    const token = {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token || (this.getToken() || {}).refresh_token || null,
      expires_at: Number(raw.expires_in) > 0 ? now + Number(raw.expires_in) * 1000 : null,
      obtained_at: now,
      // Regional data-center host, used for the real-time connection.
      host: raw.host || (this.getToken() || {}).host || null,
    };
    this.homey.settings.set(SETTINGS_KEY, token);
    this.onTokenChanged(token);
    return token;
  }

  clearToken() {
    this.homey.settings.unset(SETTINGS_KEY);
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────

  // No state parameter: Homey's OAuth2 callback relay manages the session itself.
  buildAuthorizeUrl() {
    const url = new URL(`${SSO_URL}/oauth2/grant`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    return url.toString();
  }

  async exchangeCode(code) {
    // BLUETTI rejects a still percent-encoded code with invalid_grant.
    const cleanCode = /%[0-9A-Fa-f]{2}/.test(code) ? decodeURIComponent(code) : code;
    const raw = await this._tokenRequest({
      grant_type: 'authorization_code',
      code: cleanCode,
      redirect_uri: REDIRECT_URI,
    });
    this.log(`Signed in to BLUETTI (token valid ${raw.expires_in ? `${Math.round(raw.expires_in / 3600)} h` : 'n/a'},`
      + ` refresh token: ${Boolean(raw.refresh_token)}, region host: ${raw.host || 'default'})`);
    return this._saveToken(raw);
  }

  async refreshToken() {
    // Collapse concurrent refreshes from several devices into one request.
    if (!this._refreshing) {
      this._refreshing = (async () => {
        const token = this.getToken();
        if (!token || !token.refresh_token) {
          throw new BluettiAuthError('Not signed in to BLUETTI. Repair the device to sign in again.');
        }
        try {
          const raw = await this._tokenRequest({
            grant_type: 'refresh_token',
            refresh_token: token.refresh_token,
          });
          this.log(`BLUETTI token refreshed (valid ${raw.expires_in ? `${Math.round(raw.expires_in / 3600)} h` : 'n/a'})`);
          return this._saveToken(raw);
        } catch (err) {
          if (err instanceof BluettiAuthError) this.clearToken();
          throw err;
        }
      })().finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  async _tokenRequest(params) {
    const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params });
    const res = await httpJson('POST', `${SSO_URL}/oauth2/token`, {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    }, body.toString());
    const { json } = res;
    if (json && OAUTH_AUTH_ERRORS.has(json.error)) {
      // The session is gone; the user must sign in again.
      throw new BluettiAuthError(`BLUETTI login failed: ${json.error}${json.error_description ? ` (${json.error_description})` : ''}`);
    }
    if (!res.ok || !json || !json.access_token) {
      throw new BluettiApiError(`BLUETTI token request failed (HTTP ${res.status})`, res.status);
    }
    return json;
  }

  async _validAccessToken() {
    let token = this.getToken();
    if (!token || !token.access_token) {
      throw new BluettiAuthError('Not signed in to BLUETTI. Repair the device to sign in again.');
    }
    if (token.expires_at && Date.now() > token.expires_at - 60000) {
      token = await this.refreshToken();
    }
    return token.access_token;
  }

  async getRealtimeConnectInfo() {
    const accessToken = await this._validAccessToken();
    const token = this.getToken();
    return {
      host: token.host || GATEWAY_URL,
      token: accessToken,
      headers: { 'x-os': 'open', 'x-app-key': APP_KEY, 'x-app-ver': APP_VER },
    };
  }

  // ── REST ───────────────────────────────────────────────────────────────────

  async _request(method, path, { params, body } = {}, retried = false) {
    const accessToken = await this._validAccessToken();
    const url = new URL(`${GATEWAY_URL}${API_PREFIX}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
      }
    }

    const headers = {
      // BLUETTI expects the raw token, without a "Bearer " prefix.
      Authorization: accessToken,
      'x-os': 'open',
      'x-app-key': APP_KEY,
      'x-app-ver': APP_VER,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await httpJson(method, url, headers, body ? JSON.stringify(body) : undefined);
    const { json } = res;

    const expired = res.status === 401 || res.status === 403 || (json && TOKEN_ERROR_CODES.has(json.msgCode));
    if (expired) {
      if (retried) throw new BluettiAuthError('BLUETTI session expired. Repair the device to sign in again.');
      await this.refreshToken();
      return this._request(method, path, { params, body }, true);
    }
    if (!res.ok) {
      throw new BluettiApiError(`BLUETTI cloud HTTP ${res.status}`, res.status);
    }
    if (!json || json.msgCode !== 0) {
      const code = json ? json.msgCode : 'no-json';
      const message = json && (json.message || json.msg) ? `: ${json.message || json.msg}` : '';
      throw new BluettiApiError(`BLUETTI cloud error ${code}${message}`, code);
    }
    return json.data;
  }

  async getDevices() {
    try {
      return (await this._request('GET', '/ha/v2/devices')) || [];
    } catch (err) {
      if (err instanceof BluettiAuthError) throw err;
      this.log(`v2 device list failed (${err.message}), falling back to v1`);
      return (await this._request('GET', '/ha/v1/devices')) || [];
    }
  }

  async getDeviceStates(sns) {
    const list = sns.join(',');
    return (await this._request('GET', '/ha/v1/deviceStates', { params: { sns: list } })) || [];
  }

  async bindDevices(sns) {
    return this._request('POST', '/ha/v1/bindDevices', { body: { bindSnList: sns } });
  }

  async control(sn, fnCode, fnValue) {
    return this._request('POST', '/ha/v1/fulfillment', { body: { sn, fnCode, fnValue: String(fnValue) } });
  }

}

module.exports = { BluettiCloud, BluettiAuthError, BluettiApiError };
