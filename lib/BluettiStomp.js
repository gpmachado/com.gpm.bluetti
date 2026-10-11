'use strict';

// Real-time change notifications from the BLUETTI cloud (STOMP over WebSocket).
// Port of api/websocket.py from the official Home Assistant integration.
// The server only says "device <sn> changed"; values are then re-read over REST.

const EventEmitter = require('events');
const WebSocket = require('ws');

const WS_PATH = '/api/edgeiotgw/ws-coordination/websocket';
const HEARTBEAT_MS = 55000;
// The server sends nothing while nothing changes, so liveness is checked with
// WebSocket pings (which it answers) instead of waiting for STOMP traffic.
const PING_MS = 60000;
const SILENCE_MS = 3 * PING_MS;
const CONNECT_TIMEOUT_MS = 20000;
const MIN_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 5 * 60000;
// ERROR frame codes that mean the token (or client version) is not accepted.
const AUTH_ERROR_CODES = new Set([400, 403, 600, 803, 805]);

function parseFrame(raw) {
  const text = raw.replace(/\0+$/, '');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 2);
  const lines = head.replace(/^\n+/, '').split('\n');
  const command = lines.shift();
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0 && !(line.slice(0, idx) in headers)) {
      headers[line.slice(0, idx)] = line.slice(idx + 1).replace(/\\c/g, ':').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    }
  }
  return { command, headers, body };
}

function buildFrame(command, headers, body = '') {
  const lines = [command, ...Object.entries(headers).map(([k, v]) => `${k}:${v}`)];
  return `${lines.join('\n')}\n\n${body}\0`;
}

class BluettiStomp extends EventEmitter {

  // getConnectInfo: async () => ({ url, token, headers }) — called on every (re)connect
  constructor({ getConnectInfo, log, error }) {
    super();
    this.getConnectInfo = getConnectInfo;
    this.log = log;
    this.error = error;
    this.ws = null;
    this.running = false;
    this.connected = false;
    this._reconnectMs = MIN_RECONNECT_MS;
    this._timers = new Set();
    // Bumped by stop(): a _connect() still awaiting the token must not open a second socket.
    this._gen = 0;
  }

  static urlFor(host) {
    const base = (host || 'https://gw.bluettipower.com').replace(/\/$/, '');
    return base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + WS_PATH;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._reconnectMs = MIN_RECONNECT_MS;
    this._connect().catch((err) => this._scheduleReconnect(err));
  }

  stop() {
    this.running = false;
    this._gen += 1;
    this._teardown();
  }

  restart() {
    this.stop();
    this.start();
  }

  _setTimer(fn, ms, interval = false) {
    const t = interval ? setInterval(fn, ms) : setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }

  _clearTimers() {
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers.clear();
  }

  _teardown() {
    this._clearTimers();
    this.connected = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      try { this.ws.terminate(); } catch (err) { /* ignore */ }
      this.ws = null;
    }
  }

  async _connect() {
    this._teardown();
    const gen = ++this._gen;
    const { url, token, headers } = await this.getConnectInfo();
    if (!this.running || gen !== this._gen) return;

    const host = new URL(url).hostname;
    const ws = new WebSocket(url);
    this.ws = ws;
    this._lastFrameAt = Date.now();

    this._setTimer(() => {
      if (!this.connected) this._fail(new Error('WebSocket CONNECT timed out'));
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(buildFrame('CONNECT', {
        'accept-version': '1.0,1.1,2.0',
        'heart-beat': `${HEARTBEAT_MS},${HEARTBEAT_MS}`,
        host,
        Authorization: token,
        ...headers,
      }));
    });
    ws.on('message', (data) => this._onMessage(data.toString()));
    ws.on('pong', () => { this._lastFrameAt = Date.now(); });
    ws.on('error', (err) => this._fail(err));
    ws.on('close', (code) => this._fail(new Error(`WebSocket closed (${code})`)));
  }

  _onMessage(raw) {
    this._lastFrameAt = Date.now();
    if (!raw || /^[\r\n]+$/.test(raw)) return; // heartbeat

    const frame = parseFrame(raw);
    if (frame.command === 'CONNECTED') {
      this._onConnected(frame);
    } else if (frame.command === 'MESSAGE') {
      this._onNotify(frame.body);
    } else if (frame.command === 'ERROR') {
      let info = {};
      try { info = JSON.parse(frame.headers.message || '{}'); } catch (err) { info = { message: frame.headers.message }; }
      const code = Number(info.msgCode);
      if (AUTH_ERROR_CODES.has(code)) {
        this.emit('authError', code, info.message);
      }
      this._fail(new Error(`STOMP ERROR ${Number.isFinite(code) ? code : ''} ${info.message || ''}`.trim()));
    }
  }

  _onConnected(frame) {
    const user = frame.headers['user-name'];
    if (!user) {
      this._fail(new Error('CONNECTED frame without user-name'));
      return;
    }
    this.connected = true;
    this._reconnectMs = MIN_RECONNECT_MS;

    const serverWants = Number((frame.headers['heart-beat'] || '0,0').split(',')[1]) || 0;
    const sendEvery = Math.max(HEARTBEAT_MS - 5000, serverWants || 0);
    this._setTimer(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('\n');
    }, sendEvery, true);

    // Reconnect only when the server stops answering pings.
    this._setTimer(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_MS, true);
    this._setTimer(() => {
      if (Date.now() - this._lastFrameAt > SILENCE_MS) this._fail(new Error('No answer from server, reconnecting'));
    }, 30000, true);

    this.ws.send(buildFrame('SUBSCRIBE', {
      id: 'homey',
      destination: `/ws-subscribe/user/${user}/notify`,
      ack: 'auto',
    }));
    this.log('BLUETTI real-time connection established');
  }

  _onNotify(body) {
    try {
      const json = JSON.parse(body);
      const sn = json && json.data && json.data.message && json.data.message.deviceSn;
      if (sn) this.emit('deviceChanged', String(sn));
    } catch (err) {
      this.error('Cannot parse BLUETTI notification:', err.message);
    }
  }

  _fail(err) {
    if (!this.running) return;
    this._teardown();
    this._scheduleReconnect(err);
  }

  _scheduleReconnect(err) {
    if (!this.running) return;
    const delay = this._reconnectMs;
    this._reconnectMs = Math.min(this._reconnectMs * 2, MAX_RECONNECT_MS);
    this.log(`BLUETTI real-time connection lost (${err && err.message}); retrying in ${Math.round(delay / 1000)}s`);
    this._setTimer(() => {
      this._connect().catch((e) => this._scheduleReconnect(e));
    }, delay);
  }

}

module.exports = { BluettiStomp };
