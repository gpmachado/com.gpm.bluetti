'use strict';

// Read-only BLE client for encrypted ("V2") BLUETTI power stations, on Homey's BLE manager.
// Protocol: MODBUS-over-GATT (notify 0xFF01, write 0xFF02) wrapped in AES after an ECDH handshake.
// Register map from bluetti_bt_lib/devices/el30v2.py (Patrick762/bluetti-bt-lib).

const { BluettiSession, encryptedFrameLength } = require('./BluettiCrypto');

const NOTIFY_UUID = '0000ff0100001000800000805f9b34fb';
const WRITE_UUID = '0000ff0200001000800000805f9b34fb';

const HANDSHAKE_TIMEOUT_MS = 20000;
const RESPONSE_TIMEOUT_MS = 5000;

// EL30V2 (and likely other V2 units): register → field, one 16-bit word each.
const EL30V2_REGISTERS = [
  { address: 102, name: 'soc' },
  { address: 104, name: 'time_remaining_min' },
  { address: 140, name: 'dc_output_power' },
  { address: 142, name: 'ac_output_power' },
  { address: 144, name: 'dc_input_power' },
  { address: 146, name: 'ac_input_power' },
];

const normUuid = (uuid) => String(uuid || '').toLowerCase().replace(/-/g, '');

function modbusCrc(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return crc & 0xffff;
}

function readCommand(address, quantity) {
  const cmd = Buffer.alloc(8);
  cmd[0] = 1;
  cmd[1] = 3;
  cmd.writeUInt16BE(address, 2);
  cmd.writeUInt16BE(quantity, 4);
  cmd.writeUInt16LE(modbusCrc(cmd.subarray(0, 6)), 6);
  return cmd;
}

// Matches the local name the power station advertises: model + serial (e.g. "EL30V22622110380002").
function matchesSerial(advertisement, serial) {
  const name = String(advertisement.localName || '').replace(/[^\x20-\x7e]/g, '').trim();
  return name.length > 0 && name === String(serial);
}

class BluettiBleReader {

  constructor({ homey, log, sessionOptions }) {
    this.homey = homey;
    this.log = log;
    this.sessionOptions = sessionOptions;
  }

  // Finds the power station's advertisement, by cached peripheral uuid or by advertised name.
  async findAdvertisement({ peripheralUuid, serial, scanMs = 15000 }) {
    if (peripheralUuid) {
      try {
        return await this.homey.ble.find(peripheralUuid);
      } catch (err) {
        this.log(`BLE find(${peripheralUuid}) failed: ${err.message}; scanning`);
      }
    }
    const ads = await this.homey.ble.discover([], scanMs);
    const match = ads.find((ad) => matchesSerial(ad, serial));
    if (!match) {
      const names = ads.map((ad) => ad.localName).filter(Boolean);
      this.log(`BLE scan: ${ads.length} devices, no match for ${serial}. Names: ${names.slice(0, 20).join(', ')}`);
      return null;
    }
    return match;
  }

  // Connects, runs the handshake, reads the registers and disconnects.
  async read(advertisement) {
    const peripheral = await advertisement.connect();
    let subscribed = null;
    try {
      const { notify, write } = await this._characteristics(peripheral);
      const session = new BluettiSession(this.sessionOptions);
      const link = new Link({ session, write, log: this.log });
      subscribed = notify;
      await notify.subscribeToNotifications((data) => link.onNotify(Buffer.from(data)));

      await link.waitReady(HANDSHAKE_TIMEOUT_MS);

      const values = {};
      for (const reg of EL30V2_REGISTERS) {
        const body = await link.request(readCommand(reg.address, 1), RESPONSE_TIMEOUT_MS);
        values[reg.name] = body.readUInt16BE(0);
      }
      return { values, rssi: advertisement.rssi };
    } finally {
      if (subscribed) await subscribed.unsubscribeFromNotifications().catch(() => {});
      await peripheral.disconnect().catch(() => {});
    }
  }

  async _characteristics(peripheral) {
    const services = await peripheral.discoverAllServicesAndCharacteristics();
    let notify = null;
    let write = null;
    for (const service of services) {
      for (const ch of service.characteristics || []) {
        const uuid = normUuid(ch.uuid);
        if (uuid === NOTIFY_UUID || uuid === 'ff01') notify = ch;
        if (uuid === WRITE_UUID || uuid === 'ff02') write = ch;
      }
    }
    if (!notify || !write) {
      const all = services.map((s) => `${s.uuid}[${(s.characteristics || []).map((c) => c.uuid).join(',')}]`).join(' ');
      throw new Error(`BLUETTI characteristics not found. Services: ${all}`);
    }
    return { notify, write };
  }

}

// One connection: reassembles notification fragments, drives the handshake, matches responses.
class Link {

  constructor({ session, write, log }) {
    this.session = session;
    this.writeChar = write;
    this.log = log;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.error = null;
    this._readyWaiters = [];
  }

  onNotify(chunk) {
    this._consume(chunk).catch((err) => this._fail(err));
  }

  async _consume(chunk) {
    // A handshake frame in clear text always arrives on its own.
    if (this.buffer.length === 0 && BluettiSession.isKexFrame(chunk)) {
      const reply = this.session.handlePlain(chunk);
      if (reply) await this._write(reply);
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const expected = encryptedFrameLength(this.buffer, this.session.ready);
      if (expected === null || this.buffer.length < expected) return;
      const frame = this.buffer.subarray(0, expected);
      this.buffer = this.buffer.subarray(expected);

      const result = this.session.handleEncrypted(frame);
      if (result.reply) await this._write(result.reply);
      if (this.session.ready) this._resolveReady();
      if (result.data) this._onData(result.data);
    }
  }

  _onData(data) {
    if (!this.pending) return;
    this.pending.chunks.push(data);
    const all = Buffer.concat(this.pending.chunks);
    // MODBUS read reply: [addr][fn][byteCount][data...][crc lo][crc hi]
    if (all.length >= 2 && all[1] === 0x83) {
      this._settle(new Error(`MODBUS exception ${all[2]}`));
      return;
    }
    if (all.length < 3 || all.length < all[2] + 5) return;
    const frame = all.subarray(0, all[2] + 5);
    const crc = frame.readUInt16LE(frame.length - 2);
    if (crc !== modbusCrc(frame.subarray(0, frame.length - 2))) {
      this._settle(new Error('MODBUS CRC mismatch'));
      return;
    }
    this._settle(null, frame.subarray(3, frame.length - 2));
  }

  async _write(data) {
    await this.writeChar.write(data);
  }

  waitReady(timeoutMs) {
    if (this.session.ready) return Promise.resolve();
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bluetooth handshake timed out')), timeoutMs);
      this._readyWaiters.push({
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  _resolveReady() {
    const waiters = this._readyWaiters;
    this._readyWaiters = [];
    waiters.forEach((w) => w.resolve());
  }

  _fail(err) {
    this.error = err;
    this.log(`BLE link error: ${err.message}`);
    const waiters = this._readyWaiters;
    this._readyWaiters = [];
    waiters.forEach((w) => w.reject(err));
    this._settle(err);
  }

  request(command, timeoutMs) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._settle(new Error('No answer from power station')), timeoutMs);
      this.pending = { chunks: [], resolve, reject, timer };
      this._write(this.session.encrypt(command)).catch((err) => this._settle(err));
    });
  }

  _settle(err, value) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

}

module.exports = { BluettiBleReader, modbusCrc, readCommand, matchesSerial };
