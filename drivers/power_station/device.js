'use strict';

const Homey = require('homey');
const { BluettiAuthError } = require('../../lib/BluettiCloud');
const { BluettiBleReader } = require('../../lib/ble/BluettiBleReader');

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

// SetCtrlWorkMode values, named as in the BLUETTI app. All four confirmed on EL30V2.
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
// Bluetooth fallback: never read more often than this (each read is a full connect + handshake).
const BLE_MIN_INTERVAL_MS = 60000;
// How long the last Bluetooth values stay acceptable when a read fails.
const BLE_STALE_MS = 3 * BLE_MIN_INTERVAL_MS;
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
        if (!(await this._bleFallback())) await this.setUnavailable(this.homey.__('errors.auth')).catch(this.error);
      } else {
        this._failures += 1;
        this.error(`Poll failed (${this._failures}/${MAX_FAILURES}):`, err.message);
        if (this._failures >= MAX_FAILURES && !(await this._bleFallback())) {
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
      if (await this._bleFallback()) return;
      await this.setUnavailable(this.homey.__('errors.offline')).catch(this.error);
      return;
    }
    if (this._viaBle) {
      this._viaBle = false;
      this.log('Cloud is back, leaving Bluetooth fallback');
      await this.unsetWarning().catch(this.error);
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

  // ── Bluetooth fallback ─────────────────────────────────────────────────────

  get ble() {
    if (!this._ble) this._ble = new BluettiBleReader({ homey: this.homey, log: (...a) => this.log(...a) });
    return this._ble;
  }

  // Cloud unusable: read over Bluetooth instead. Returns true when values are current.
  async _bleFallback() {
    if (!this.getSetting('ble_fallback')) return false;
    if (this._bleLastOk && Date.now() - this._bleLastOk < BLE_MIN_INTERVAL_MS) return true;
    try {
      await this._bleRead();
      if (!this._viaBle) {
        this._viaBle = true;
        this.log('Cloud unavailable, using Bluetooth fallback');
      }
      await this.setAvailable().catch(this.error);
      await this.setWarning(this.homey.__('ble.warning')).catch(this.error);
      return true;
    } catch (err) {
      this.error('Bluetooth read failed:', err.message);
      // Ride out a single miss: keep the last Bluetooth values while they are recent.
      return Boolean(this._viaBle && this._bleLastOk && Date.now() - this._bleLastOk < BLE_STALE_MS);
    }
  }

  async _bleRead() {
    if (this._bleBusy) return this._bleBusy;
    this._bleBusy = (async () => {
      const started = Date.now();
      const ad = await this.ble.findAdvertisement({ peripheralUuid: this.getStoreValue('ble_uuid'), serial: this.sn });
      if (!ad) throw new Error(this.homey.__('ble.not_found'));
      if (ad.uuid && ad.uuid !== this.getStoreValue('ble_uuid')) await this.setStoreValue('ble_uuid', ad.uuid).catch(this.error);

      const { values, rssi } = await this.ble.read(ad);
      this._bleLastOk = Date.now();
      this.log(`Bluetooth read in ${Date.now() - started} ms (RSSI ${rssi}):`, JSON.stringify(values));
      await this._applyBleValues(values);
      const time = new Date().toLocaleTimeString('en-GB', { timeZone: this.homey.clock.getTimezone() });
      await this.setSettings({
        ble_status: this.homey.__('ble.status_ok', { time, soc: values.soc, rssi }),
      }).catch(this.error);
      return values;
    })().finally(() => {
      this._bleBusy = null;
    });
    return this._bleBusy;
  }

  async _applyBleValues(v) {
    if (v.soc <= 100) {
      await this._set('measure_battery', v.soc);
      await this._set('bluetti_soc', v.soc);
    }
    await this._set('measure_power.pv_in', v.dc_input_power);
    await this._set('measure_power.grid_in', v.ac_input_power);
    await this._set('measure_power.ac_out', v.ac_output_power);
    await this._set('measure_power.dc_out', v.dc_output_power);
    const net = v.dc_input_power + v.ac_input_power - v.ac_output_power - v.dc_output_power;
    await this._set('measure_power', net);
    // One "time remaining" register: towards empty when discharging, towards full when charging.
    const remaining = formatMinutes(v.time_remaining_min);
    await this._set('bluetti_time_to_empty', net < 0 ? remaining : '–');
    await this._set('bluetti_time_to_full', net > 0 ? remaining : '–');
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

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) this.restartPolling(1000);
    if (changedKeys.includes('ble_fallback')) {
      if (newSettings.ble_fallback) {
        // Test right away so the user sees whether Bluetooth works, without waiting for an outage.
        this.homey.setTimeout(() => {
          this._bleRead().catch(async (err) => {
            this.error('Bluetooth test failed:', err.message);
            await this.setSettings({ ble_status: this.homey.__('ble.status_error', { message: err.message }) }).catch(this.error);
          });
        }, 500);
      } else if (this._viaBle) {
        this._viaBle = false;
        await this.unsetWarning().catch(this.error);
        this.restartPolling(1000);
      }
    }
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
    this.log(`Power station ${this.getName()} removed`);
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
