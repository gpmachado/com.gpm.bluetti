'use strict';

const v8 = require('v8');
const Homey = require('homey');
const { BluettiCloud, BluettiAuthError } = require('./lib/BluettiCloud');
const { BluettiStomp } = require('./lib/BluettiStomp');
const { maskSn } = require('./lib/diag');

// process.memoryUsage() throws inside the Homey sandbox (no access to the process RSS),
// so only the V8 heap is reported, and never at the cost of crashing.
function heapMb() {
  try {
    return Math.round(v8.getHeapStatistics().used_heap_size / 1048576);
  } catch (err) {
    return '?';
  }
}

class BluettiApp extends Homey.App {

  async onInit() {
    this.cloud = new BluettiCloud({
      homey: this.homey,
      log: (...args) => this.log(...args),
      onTokenChanged: () => this._onTokenChanged(),
    });

    this.realtime = new BluettiStomp({
      getConnectInfo: async () => {
        const info = await this.cloud.getRealtimeConnectInfo();
        return { url: BluettiStomp.urlFor(info.host), token: info.token, headers: info.headers };
      },
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });
    this.realtime.on('deviceChanged', (sn) => this._onDeviceChanged(sn));
    this.realtime.on('authError', (code) => this._onRealtimeAuthError(code));

    this.outputChangedTrigger = this.homey.flow.getDeviceTriggerCard('output_changed')
      .registerRunListener(async (args, state) => args.output === state.output);
    this.wentOfflineTrigger = this.homey.flow.getDeviceTriggerCard('went_offline');
    this.cameOnlineTrigger = this.homey.flow.getDeviceTriggerCard('came_online');

    this.homey.flow.getActionCard('set_output')
      .registerRunListener(async (args) => args.device.setOutput(args.output, args.state === 'on'));

    this.homey.flow.getConditionCard('output_is_on')
      .registerRunListener(async (args) => args.device.isOutputOn(args.output));

    this.log(`BLUETTI app v${this.homey.manifest.version} initialized on Homey ${this.homey.version}`
      + ` (${this.homey.platform}${this.homey.platformVersion ? ` v${this.homey.platformVersion}` : ''}),`
      + ` Node ${process.version}, heap ${heapMb()} MB, signed in: ${this.cloud.hasToken()}`);
  }

  async onUninit() {
    this.realtime.stop();
  }

  _devices() {
    try {
      return this.homey.drivers.getDriver('power_station').getDevices();
    } catch (err) {
      return [];
    }
  }

  // Called by devices on init/delete so the real-time link only runs when needed.
  updateRealtime() {
    const wanted = this.cloud.hasToken() && this._devices().length > 0;
    if (wanted) this.realtime.start();
    else this.realtime.stop();
  }

  _onTokenChanged() {
    // New access token: reconnect so the WebSocket uses it.
    if (this.realtime.running) this.realtime.restart();
    else this.updateRealtime();
  }

  _onDeviceChanged(sn) {
    const device = this._devices().find((d) => String(d.getData().id) === sn);
    if (device) device.onCloudNotification();
    else this.log(`Real-time notification for a power station not added to Homey (${maskSn(sn)})`);
  }

  async _onRealtimeAuthError(code) {
    // At most one refresh per 10 min, so a rejection that is not about the token
    // (e.g. code 600 "upgrade required") just backs off instead of looping.
    if (this._refreshingForRealtime || Date.now() - (this._lastRealtimeRefresh || 0) < 10 * 60000) return;
    this._refreshingForRealtime = true;
    this._lastRealtimeRefresh = Date.now();
    try {
      this.log(`Real-time connection rejected (code ${code}), refreshing token`);
      await this.cloud.refreshToken(); // triggers _onTokenChanged → restart
    } catch (err) {
      this.error('Token refresh after real-time rejection failed:', err.message);
      if (err instanceof BluettiAuthError) this.realtime.stop();
    } finally {
      this._refreshingForRealtime = false;
    }
  }

}

module.exports = BluettiApp;
