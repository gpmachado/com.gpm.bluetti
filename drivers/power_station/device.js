'use strict';

const Homey = require('homey');
const { BluettiAuthError } = require('../../lib/BluettiCloud');
const { BluettiBleReader } = require('../../lib/ble/BluettiBleReader');
const { maskSn, formatStates } = require('../../lib/diag');

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

// Default battery capacity per model (Wh), for the "Backup time" estimate. Users of other
// models (or with expansion batteries) enter their capacity in the device settings.
const CAPACITY_WH = {
  EL30V2: 288,
};
// Inverter + conversion efficiency when running the loads from the battery.
const BACKUP_EFFICIENCY = 0.9;
// Below this load the estimate is meaningless (and would be days long).
const BACKUP_MIN_LOAD_W = 5;

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
// Safety-net polling while the real-time link is connected.
const REALTIME_POLL_SEC = 300;
// Interval of the diagnostic summary line in the log.
const SUMMARY_INTERVAL_MS = 60 * 60000;

class PowerStationDevice extends Homey.Device {

  async onInit() {
    this.sn = this.getData().id;
    this._failures = 0;
    this._online = null;
    this._pollTimer = null;
    this._polling = false;
    this._snapshotLogged = false;
    this._resetStats();

    // Capabilities added after the first release.
    for (const capability of ['bluetti_soc', 'bluetti_time_to_empty', 'bluetti_time_to_full']) {
      if (!this.hasCapability(capability)) await this.addCapability(capability).catch(this.error);
    }
    // Pre-fill the capacity for known models; 0 means unknown.
    if (!Number(this.getSetting('capacity_wh')) && this.defaultCapacityWh) {
      await this.setSettings({ capacity_wh: this.defaultCapacityWh }).catch(this.error);
    }
    await this._syncBackupCapabilities();

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
    this._summaryTimer = this.homey.setInterval(() => this._logSummary(), SUMMARY_INTERVAL_MS);
    this.log(`Power station ${this.getName()} initialized: sn=${maskSn(this.sn)} model=${this.getSetting('model') || '?'}`
      + ` capacity=${this.capacityWh || '?'}Wh poll=${this.getSetting('poll_interval')}s`
      + ` bleFallback=${this.getSetting('ble_fallback') ? 'on' : 'off'} detailedLog=${this.detailedLog ? 'on' : 'off'}`);
  }

  get cloud() {
    return this.homey.app.cloud;
  }

  get detailedLog() {
    return Boolean(this.getSetting('debug_logging'));
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  _resetStats() {
    this._stats = {
      since: Date.now(), polls: 0, pollFails: 0, notifies: 0, bleReads: 0, bleFails: 0, lastError: null,
    };
  }

  _noteError(err) {
    this._stats.lastError = `${new Date().toISOString()} ${err.message}`;
  }

  // One line per hour so diagnostic reports show how the device behaved over time.
  _logSummary() {
    const st = this._stats;
    const minutes = Math.round((Date.now() - st.since) / 60000);
    this.log(`Summary (${minutes} min): cloudPolls=${st.polls} cloudFails=${st.pollFails}`
      + ` realtimeNotifies=${st.notifies} realtime=${this.homey.app.realtime.connected ? 'up' : 'down'}`
      + ` bleReads=${st.bleReads} bleFails=${st.bleFails} viaBle=${Boolean(this._viaBle)}`
      + ` online=${this._online} soc=${this.getCapabilityValue('measure_battery')}`
      + ` mode=${this.getCapabilityValue('bluetti_work_mode')}`
      + `${st.lastError ? ` lastError="${st.lastError}"` : ''}`);
    this._resetStats();
  }

  get capacityWh() {
    return Number(this.getSetting('capacity_wh')) || null;
  }

  // Backup time is only shown when the battery capacity is known.
  async _syncBackupCapabilities() {
    for (const capability of ['bluetti_backup_time', 'bluetti_backup_minutes']) {
      if (this.capacityWh && !this.hasCapability(capability)) await this.addCapability(capability).catch(this.error);
      if (!this.capacityWh && this.hasCapability(capability)) await this.removeCapability(capability).catch(this.error);
    }
  }

  get defaultCapacityWh() {
    const model = String(this.getSetting('model') || this.getStoreValue('model') || '').toUpperCase();
    if (CAPACITY_WH[model]) return CAPACITY_WH[model];
    // The serial starts with the model, e.g. "EL30V22622110380002".
    const byPrefix = Object.keys(CAPACITY_WH).find((m) => String(this.sn).toUpperCase().startsWith(m));
    return byPrefix ? CAPACITY_WH[byPrefix] : null;
  }

  // How long the current loads would run from the battery if the grid failed now.
  // While actually running on battery, BLUETTI's own estimate is used (it is accurate then).
  async _updateBackup({ soc, load, onBattery, bluettiMinutes }) {
    if (!this.hasCapability('bluetti_backup_time') || soc === null || load === null) return;
    let minutes = null;
    if (onBattery && bluettiMinutes > 0) {
      minutes = bluettiMinutes;
    } else if (load >= BACKUP_MIN_LOAD_W) {
      minutes = Math.round(((soc / 100) * this.capacityWh * BACKUP_EFFICIENCY / load) * 60);
    }
    await this._set('bluetti_backup_time', minutes === null ? '–' : formatMinutes(minutes));
    if (minutes !== null) await this._set('bluetti_backup_minutes', minutes);
  }

  _fullLabel(soc, minutes) {
    return soc !== null && soc >= 100 && !(minutes > 0) ? this.homey.__('full') : formatMinutes(minutes);
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
    // The real-time link pushes every change (including "went offline"), so polling is only a
    // safety net while it is up. Without it, or while the cloud reports the unit offline, use the setting.
    const configured = Math.max(15, Number(this.getSetting('poll_interval')) || 30);
    const realtimeUp = this.homey.app.realtime.connected && this._online === true;
    const intervalSec = realtimeUp ? Math.max(configured, REALTIME_POLL_SEC) : configured;
    if (!this._pollTimer) this._pollTimer = this.homey.setTimeout(() => this._pollLoop(), intervalSec * 1000);
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    this._lastPollStart = Date.now();
    try {
      let product = await this._fetchProduct();
      if (!product || String(product.isBindByCurUser) === '0') {
        // Removing and re-adding the unit in the BLUETTI app drops the integration binding.
        if (await this._rebind()) product = await this._fetchProduct();
      }
      if (!product) throw new Error('Power station not returned by the BLUETTI cloud');
      this._failures = 0;
      this._stats.polls += 1;
      if (!this._snapshotLogged || this.detailedLog) {
        // Full payload once per start (or every poll with detailed logging): the key to supporting new models.
        this._snapshotLogged = true;
        this.log(`Cloud data: model=${product.model} online=${product.online} bound=${product.isBindByCurUser}`
          + ` states: ${formatStates(product.stateList)}`);
      }
      await this._applyProduct(product);
    } catch (err) {
      this._noteError(err);
      if (err instanceof BluettiAuthError) {
        this.error('Auth error:', err.message);
        // Still read over Bluetooth, but tell the user to sign in again (Repair).
        if (!(await this._bleFallback('errors.auth'))) await this.setUnavailable(this.homey.__('errors.auth')).catch(this.error);
      } else {
        this._failures += 1;
        this._stats.pollFails += 1;
        this.error(`Poll failed (${this._failures}/${MAX_FAILURES}):`, err.message);
        if (this._failures >= MAX_FAILURES && !(await this._bleFallback())) {
          await this.setUnavailable(this.homey.__('errors.cloud', { message: err.message })).catch(this.error);
        }
      }
    } finally {
      this._polling = false;
      if (this._pollAgain && !this._deleted) {
        this._pollAgain = false;
        this.restartPolling();
      }
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
      this.log(`Cloud reports the power station ${online ? 'online' : 'OFFLINE (no Wi-Fi/internet on the unit)'}`);
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
    if (chg !== null) await this._set('bluetti_time_to_full', this._fullLabel(soc, chg));

    const pvIn = toNumber(states.PVAllTotalPower);
    const gridIn = toNumber(states.GridAllTotalPower);
    const acOut = toNumber(states.ACLoadAllTotalPower);
    const dcOut = toNumber(states.DCLoadAllTotalPower);
    if ([pvIn, gridIn, acOut, dcOut].some((v) => v !== null)) {
      // Positive = battery charging, negative = discharging (conversion losses ignored).
      const net = (pvIn || 0) + (gridIn || 0) - (acOut || 0) - (dcOut || 0);
      await this._set('measure_power', net);
      await this._updateBackup({
        soc, load: (acOut || 0) + (dcOut || 0), onBattery: net < 0, bluettiMinutes: dsg,
      });
    }

    for (const [output, fnCode] of Object.entries(SWITCH_MAP)) {
      if (states[fnCode] !== undefined) await this._setOutputState(output, String(states[fnCode]) === '1', 'cloud');
    }

    if (states.SetCtrlWorkMode !== undefined) {
      const mode = this._workModeLabel(entries.SetCtrlWorkMode);
      const previousMode = this.getCapabilityValue('bluetti_work_mode');
      if (previousMode && previousMode !== mode) this.log(`Working mode changed: ${previousMode} → ${mode}`);
      await this._set('bluetti_work_mode', mode);
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
    this._stats.notifies += 1;
    if (this.detailedLog) this.log('Real-time notification from cloud');
    const notifiedAt = Date.now();
    if (this._notifyTimer) return;
    this._notifyTimer = this.homey.setTimeout(() => {
      this._notifyTimer = null;
      // A read that started after the notification already has the new values.
      if (this._lastPollStart >= notifiedAt) return;
      if (this._polling) this._pollAgain = true;
      else this.restartPolling();
    }, NOTIFY_DEBOUNCE_MS);
  }

  // ── Bluetooth fallback ─────────────────────────────────────────────────────

  get ble() {
    if (!this._ble) this._ble = new BluettiBleReader({ homey: this.homey, log: (...a) => this.log(...a) });
    return this._ble;
  }

  // Cloud unusable: read over Bluetooth instead. Returns true when values are current.
  async _bleFallback(warningKey = 'ble.warning') {
    if (!this.getSetting('ble_fallback')) return false;
    if (this._bleLastOk && Date.now() - this._bleLastOk < BLE_MIN_INTERVAL_MS) return true;
    try {
      await this._bleRead();
      if (!this._viaBle) {
        this._viaBle = true;
        this.log('Cloud unavailable, using Bluetooth fallback');
      }
      await this.setAvailable().catch(this.error);
      await this.setWarning(this.homey.__(warningKey)).catch(this.error);
      return true;
    } catch (err) {
      this._stats.bleFails += 1;
      this._noteError(err);
      this.error('Bluetooth read failed:', err.message);
      // Ride out a single miss: keep the last Bluetooth values while they are recent.
      return Boolean(this._viaBle && this._bleLastOk && Date.now() - this._bleLastOk < BLE_STALE_MS);
    }
  }

  async _bleRead() {
    if (this._bleBusy) return this._bleBusy;
    this._bleBusy = (async () => {
      const started = Date.now();
      const find = async () => {
        const found = await this.ble.findAdvertisement({ peripheralUuid: this.getStoreValue('ble_uuid'), serial: this.sn });
        if (!found) throw new Error(this.homey.__('ble.not_found'));
        if (found.uuid && found.uuid !== this.getStoreValue('ble_uuid')) await this.setStoreValue('ble_uuid', found.uuid).catch(this.error);
        return found;
      };

      // Reuse the last advertisement: finding it again costs ~10 s per read.
      // If it went stale, find the power station again and retry once.
      let ad = this._bleAd;
      let result;
      try {
        if (!ad) ad = await find();
        result = await this.ble.read(ad);
      } catch (err) {
        if (!this._bleAd) throw err;
        this.log(`Cached Bluetooth advertisement failed (${err.message}), searching again`);
        this._bleAd = null;
        ad = await find();
        result = await this.ble.read(ad);
      }
      this._bleAd = ad;
      const { values, rssi } = result;
      this._bleLastOk = Date.now();
      this._stats.bleReads += 1;
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
    await this._set('bluetti_time_to_full', net > 0 ? remaining : this._fullLabel(v.soc, 0));
    await this._updateBackup({
      soc: v.soc <= 100 ? v.soc : null,
      load: v.ac_output_power + v.dc_output_power,
      onBattery: net < 0,
      bluettiMinutes: v.time_remaining_min,
    });
  }

  // ── Control ────────────────────────────────────────────────────────────────

  async setOutput(output, on) {
    const fnCode = SWITCH_MAP[output];
    if (!fnCode) throw new Error(`Unknown output ${output}`);
    this.log(`Setting ${fnCode} → ${on ? 1 : 0}`);
    try {
      await this.cloud.control(this.sn, fnCode, on ? '1' : '0');
    } catch (err) {
      this._noteError(err);
      this.error(`Command ${fnCode} failed:`, err.message);
      throw err;
    }

    await this._setOutputState(output, on, 'Homey');
    this.restartPolling(POST_COMMAND_POLL_MS);
  }

  // Stores an output state and fires "output changed" once per real change.
  async _setOutputState(output, on, source) {
    const capability = `onoff.${output}`;
    const previous = this.getCapabilityValue(capability);
    await this._set(capability, on);
    if (previous !== null && previous !== on) {
      this.log(`Output ${output} turned ${on ? 'on' : 'off'} (by ${source})`);
      this.homey.app.outputChangedTrigger.trigger(this, { state: on }, { output }).catch(this.error);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onSettings({ newSettings, changedKeys }) {
    this.log(`Settings changed: ${changedKeys.map((k) => `${k}=${newSettings[k]}`).join(' ')}`);
    if (changedKeys.includes('poll_interval')) this.restartPolling(1000);
    if (changedKeys.includes('capacity_wh')) {
      // Settings are saved after this handler returns, so apply them right after.
      this.homey.setTimeout(() => {
        this._syncBackupCapabilities().then(() => this.restartPolling(500)).catch(this.error);
      }, 500);
    }
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
    if (this._summaryTimer) this.homey.clearInterval(this._summaryTimer);
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
