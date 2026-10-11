'use strict';

const Homey = require('homey');
const { BluettiAuthError } = require('../../lib/BluettiCloud');

// fnCode (BLUETTI cloud) → numeric capability. Verified on Elite 30 V2.
const NUMERIC_MAP = {
  SOC: 'measure_battery',
  PVAllTotalPower: 'measure_power.pv_in',
  GridAllTotalPower: 'measure_power.grid_in',
  ACLoadAllTotalPower: 'measure_power.ac_out',
  DCLoadAllTotalPower: 'measure_power.dc_out',
  DsgFullTime: 'bluetti_discharge_time',
  ChgFullTime: 'bluetti_charge_time',
};

// Output id (flow cards / onoff.<id>) ↔ fnCode of the switch.
const SWITCH_MAP = {
  ac: 'SetCtrlAc',
  dc: 'SetCtrlDc',
  ac_eco: 'SetACECO',
  dc_eco: 'SetDCECO',
};

// SetCtrlWorkMode values, named as in the BLUETTI app. workmode_0 and workmode_1 confirmed on EL30V2;
// 2 and 3 follow the order of the app and the official HA integration (oak_device_gen2.py).
const WORK_MODES = {
  workmode_0: 'pv_priority_ups',
  workmode_1: 'standard_ups',
  workmode_2: 'time_control_ups',
  workmode_3: 'custom_ups',
};

const KNOWN_CODES = new Set([...Object.keys(NUMERIC_MAP), ...Object.values(SWITCH_MAP), 'SetCtrlWorkMode']);

// Consecutive cloud failures before the device is shown as unavailable.
const MAX_FAILURES = 3;
// Delay before re-reading after a command, so the cloud has the new state.
const POST_COMMAND_POLL_MS = 4000;
// Minimum time between automatic re-bind attempts.
const REBIND_INTERVAL_MS = 10 * 60000;
// Coalesce bursts of real-time notifications into one read.
const NOTIFY_DEBOUNCE_MS = 1500;

class PowerStationDevice extends Homey.Device {

  async onInit() {
    this.sn = this.getData().id;
    this._failures = 0;
    this._online = null;
    this._loggedUnknown = new Set();
    this._pollTimer = null;
    this._polling = false;

    // Capabilities added after the first release.
    for (const capability of ['bluetti_soc', 'bluetti_time_to_empty', 'bluetti_time_to_full']) {
      if (!this.hasCapability(capability)) await this.addCapability(capability).catch(this.error);
    }

    for (const output of Object.keys(SWITCH_MAP)) {
      this.registerCapabilityListener(`onoff.${output}`, async (value) => this.setOutput(output, value));
    }

    if (!this.getStoreValue('bound')) {
      try {
        await this.cloud.bindDevices([this.sn]);
        await this.setStoreValue('bound', true);
      } catch (err) {
        // Not fatal: the device list already comes from this account.
        this.log('bindDevices failed:', err.message);
      }
    }

    this.restartPolling();
    // Deferred so getDevices() already includes this device.
    this.homey.setTimeout(() => this.homey.app.updateRealtime(), 1000);
    this.log(`Power station ${this.getName()} initialized`);
  }

  get cloud() {
    return this.homey.app.cloud;
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  restartPolling(delayMs = 0) {
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = this.homey.setTimeout(() => this._pollLoop(), delayMs);
  }

  async _pollLoop() {
    this._pollTimer = null;
    await this.poll();
    if (this._deleted) return;
    const intervalSec = Math.max(15, Number(this.getSetting('poll_interval')) || 30);
    if (!this._pollTimer) this._pollTimer = this.homey.setTimeout(() => this._pollLoop(), intervalSec * 1000);
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      let product = await this._fetchProduct();
      if (!product || String(product.isBindByCurUser) === '0') {
        // Removing and re-adding the unit in the BLUETTI app drops the integration binding.
        if (await this._rebind()) product = await this._fetchProduct();
      }
      if (!product) throw new Error('Power station not returned by the BLUETTI cloud');
      this._failures = 0;
      await this._applyProduct(product);
    } catch (err) {
      if (err instanceof BluettiAuthError) {
        this.error('Auth error:', err.message);
        await this.setUnavailable(this.homey.__('errors.auth')).catch(this.error);
      } else {
        this._failures += 1;
        this.error(`Poll failed (${this._failures}/${MAX_FAILURES}):`, err.message);
        if (this._failures >= MAX_FAILURES) {
          await this.setUnavailable(this.homey.__('errors.cloud', { message: err.message })).catch(this.error);
        }
      }
    } finally {
      this._polling = false;
    }
  }

  async _fetchProduct() {
    const list = await this.cloud.getDeviceStates([this.sn]);
    return list.find((p) => String(p.sn) === String(this.sn)) || null;
  }

  // Binds this serial to the integration again; at most once per REBIND_INTERVAL_MS.
  async _rebind() {
    if (Date.now() - (this._lastRebind || 0) < REBIND_INTERVAL_MS) return false;
    this._lastRebind = Date.now();
    try {
      this.log('Power station not bound to this integration, binding again');
      await this.cloud.bindDevices([this.sn]);
      await this.setStoreValue('bound', true).catch(this.error);
      return true;
    } catch (err) {
      this.error('bindDevices failed:', err.message);
      return false;
    }
  }

  async _applyProduct(product) {
    const online = String(product.online) === '1';
    if (online !== this._online) {
      const previous = this._online;
      this._online = online;
      if (previous !== null) {
        const card = online ? this.homey.app.cameOnlineTrigger : this.homey.app.wentOfflineTrigger;
        card.trigger(this).catch(this.error);
      }
    }
    if (!online) {
      await this.setUnavailable(this.homey.__('errors.offline')).catch(this.error);
      return;
    }
    await this.setAvailable().catch(this.error);

    if (product.model && this.getSetting('model') !== product.model) {
      await this.setSettings({ model: String(product.model) }).catch(this.error);
    }

    const states = {};
    const entries = {};
    for (const entry of product.stateList || []) {
      if (!entry || !entry.fnCode) continue;
      states[entry.fnCode] = entry.fnValue;
      entries[entry.fnCode] = entry;
      if (!KNOWN_CODES.has(entry.fnCode) && !this._loggedUnknown.has(entry.fnCode)) {
        this._loggedUnknown.add(entry.fnCode);
        this.log(`Unmapped fnCode ${entry.fnCode} (${entry.fnName}, ${entry.fnType}) = ${entry.fnValue}`);
      }
    }

    for (const [fnCode, capability] of Object.entries(NUMERIC_MAP)) {
      const value = toNumber(states[fnCode]);
      if (value !== null) await this._set(capability, value);
    }

    // Same SOC again as a sensor, so it shows next to the power readings
    // (measure_battery is always rendered on its own battery tab).
    const soc = toNumber(states.SOC);
    if (soc !== null) await this._set('bluetti_soc', soc);

    // Human-readable remaining times, like the BLUETTI app ("1d 9h 6m").
    const dsg = toNumber(states.DsgFullTime);
    if (dsg !== null) await this._set('bluetti_time_to_empty', formatMinutes(dsg));
    const chg = toNumber(states.ChgFullTime);
    if (chg !== null) await this._set('bluetti_time_to_full', formatMinutes(chg));

    const pvIn = toNumber(states.PVAllTotalPower);
    const gridIn = toNumber(states.GridAllTotalPower);
    const acOut = toNumber(states.ACLoadAllTotalPower);
    const dcOut = toNumber(states.DCLoadAllTotalPower);
    if ([pvIn, gridIn, acOut, dcOut].some((v) => v !== null)) {
      // Positive = battery charging, negative = discharging (conversion losses ignored).
      await this._set('measure_power', (pvIn || 0) + (gridIn || 0) - (acOut || 0) - (dcOut || 0));
    }

    for (const [output, fnCode] of Object.entries(SWITCH_MAP)) {
      if (states[fnCode] === undefined) continue;
      const on = String(states[fnCode]) === '1';
      const capability = `onoff.${output}`;
      const previous = this.getCapabilityValue(capability);
      await this._set(capability, on);
      if (previous !== null && previous !== on) {
        this.homey.app.outputChangedTrigger.trigger(this, { state: on }, { output }).catch(this.error);
      }
    }

    if (states.SetCtrlWorkMode !== undefined) {
      await this._set('bluetti_work_mode', this._workModeLabel(entries.SetCtrlWorkMode));
    }
  }

  _workModeLabel(entry) {
    const value = String(entry.fnValue);
    if (WORK_MODES[value]) return this.homey.__(`work_mode.${WORK_MODES[value]}`);
    // Unknown code: use the cloud's own label when it sends one.
    const option = (entry.supportModeValues || []).find((v) => String(v.code) === value);
    if (option && option.name) return String(option.name);
    return value;
  }

  async _set(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  // The cloud pushed "this device changed": re-read soon, coalescing bursts.
  onCloudNotification() {
    if (this._notifyTimer) return;
    this._notifyTimer = this.homey.setTimeout(() => {
      this._notifyTimer = null;
      this.restartPolling();
    }, NOTIFY_DEBOUNCE_MS);
  }

  // ── Control ────────────────────────────────────────────────────────────────

  async setOutput(output, on) {
    const fnCode = SWITCH_MAP[output];
    if (!fnCode) throw new Error(`Unknown output ${output}`);
    this.log(`Setting ${fnCode} → ${on ? 1 : 0}`);
    await this.cloud.control(this.sn, fnCode, on ? '1' : '0');

    const capability = `onoff.${output}`;
    const previous = this.getCapabilityValue(capability);
    await this._set(capability, on);
    if (previous !== null && previous !== on) {
      this.homey.app.outputChangedTrigger.trigger(this, { state: on }, { output }).catch(this.error);
    }
    this.restartPolling(POST_COMMAND_POLL_MS);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) this.restartPolling(1000);
  }

  _stop() {
    this._deleted = true;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    if (this._notifyTimer) this.homey.clearTimeout(this._notifyTimer);
    this._pollTimer = null;
    this._notifyTimer = null;
  }

  async onDeleted() {
    this._stop();
    this.homey.setTimeout(() => this.homey.app.updateRealtime(), 1000);
  }

  async onUninit() {
    this._stop();
  }

}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 1986 → "1d 9h 6m"; 0 means "not applicable" (not charging / not discharging).
function formatMinutes(total) {
  const minutes = Math.round(total);
  if (minutes <= 0) return '–';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

module.exports = PowerStationDevice;
