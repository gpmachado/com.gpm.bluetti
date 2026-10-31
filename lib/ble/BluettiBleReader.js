'use strict';

// BLE client for encrypted ("V2") BLUETTI power stations, on Homey's BLE manager: reads values and
// switches outputs.
// Protocol: MODBUS-over-GATT (notify 0xFF01, write 0xFF02) wrapped in AES after an ECDH handshake.
// Register map from bluetti_bt_lib/devices/el30v2.py (Patrick762/bluetti-bt-lib).

const { BluettiSession, encryptedFrameLength } = require('./BluettiCrypto');

const NOTIFY_UUID = '0000ff0100001000800000805f9b34fb';
const WRITE_UUID = '0000ff0200001000800000805f9b34fb';

const HANDSHAKE_TIMEOUT_MS = 20000;
const RESPONSE_TIMEOUT_MS = 5000;
// Right after the handshake the unit can still be sending; a leftover piece of that would be read as
// the start of the first answer. Wait for a quiet line first (bluetti-bt-lib sleeps 5 s here).
const QUIET_MS = 500;
const QUIET_MAX_MS = 3000;
// The unit applies a switch a moment after acknowledging the write (seen: still the old value
// ~0.3 s later). Read it back a few times before calling the command refused.
const CONFIRM_DELAY_MS = 400;
const CONFIRM_TRIES = 5;
// Homey can deliver one notification several times (seen: three times, back to back).
const DUPLICATE_WINDOW_MS = 100;

// EL30V2 (and likely other V2 units): register → field, one 16-bit word each.
const EL30V2_REGISTERS = [
  { address: 102, name: 'soc' },
  { address: 104, name: 'time_remaining_min' },
  { address: 140, name: 'dc_output_power' },
  { address: 142, name: 'ac_output_power' },
  { address: 144, name: 'dc_input_power' },
  { address: 146, name: 'ac_input_power' },
];
// Output switches (read and write, 1 = on), same ids as the device's onoff.<id> capabilities.
const OUTPUT_REGISTERS = {
  ac: 2011,
  dc: 2012,
  dc_eco: 2014,
  ac_eco: 2017,
};

const normUuid = (uuid) => String(uuid || '').toLowerCase().replace(/-/g, '');

function modbusCrc(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return crc & 0xffff;
}

function modbusCommand(fn, address, word) {
  const cmd = Buffer.alloc(8);
  cmd[0] = 1;
  cmd[1] = fn;
  cmd.writeUInt16BE(address, 2);
  cmd.writeUInt16BE(word, 4);
  cmd.writeUInt16LE(modbusCrc(cmd.subarray(0, 6)), 6);
  return cmd;
}

const readCommand = (address, quantity) => modbusCommand(3, address, quantity);
const writeCommand = (address, value) => modbusCommand(6, address, value);

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
  async findAdvertisement({ peripheralUuid, serial }) {
    if (peripheralUuid) {
      try {
        return await this.homey.ble.find(peripheralUuid);
      } catch (err) {
        this.log(`BLE find(${peripheralUuid}) failed: ${err.message}; scanning`);
      }
    }
    // Two scans, 5 s apart: the unit briefly stops advertising, e.g. while it reconnects to Wi-Fi.
    // (Back to back, Homey just returns the same cached result.)
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 5000));
      const ads = await this.homey.ble.discover([]);
      const match = ads.find((ad) => matchesSerial(ad, serial));
      if (match) return match;
      // Only a hint, never other people's device names: these lines end up in diagnostic reports.
      const model = String(serial).slice(0, 6);
      const similar = ads.filter((ad) => String(ad.localName || '').startsWith(model)).length;
      this.log(`BLE scan ${attempt}: ${ads.length} devices, no match for ${serial} (${similar} with a name starting with ${model})`);
    }
    return null;
  }

  // Connects, runs the handshake, reads the registers and disconnects.
  async read(advertisement) {
    return this._connected(advertisement, async (link) => {
      const values = {};
      for (const reg of EL30V2_REGISTERS) {
        values[reg.name] = (await link.request(readCommand(reg.address, 1), RESPONSE_TIMEOUT_MS)).readUInt16BE(0);
      }
      // Models without these registers answer with a MODBUS exception: leave the output out.
      const outputs = {};
      for (const [output, address] of Object.entries(OUTPUT_REGISTERS)) {
        try {
          outputs[output] = (await link.request(readCommand(address, 1), RESPONSE_TIMEOUT_MS)).readUInt16BE(0) === 1;
        } catch (err) {
          if (!err.modbusException) throw err;
        }
      }
      return { values, outputs };
    });
  }

  // Switches an output, then reads it back. Returns the state the power station reports.
  async setOutput(advertisement, output, on) {
    const address = OUTPUT_REGISTERS[output];
    if (address === undefined) throw new Error(`No Bluetooth register for ${output}`);
    return this._connected(advertisement, async (link) => {
      await link.request(writeCommand(address, on ? 1 : 0), RESPONSE_TIMEOUT_MS);
      let state;
      for (let i = 0; i < CONFIRM_TRIES && state !== on; i++) {
        await new Promise((r) => setTimeout(r, CONFIRM_DELAY_MS));
        state = (await link.request(readCommand(address, 1), RESPONSE_TIMEOUT_MS)).readUInt16BE(0) === 1;
      }
      return state;
    });
  }

  static hasOutput(output) {
    return OUTPUT_REGISTERS[output] !== undefined;
  }

  // Connects, runs the handshake, calls fn(link) and disconnects.
  async _connected(advertisement, fn) {
    let peripheral;
    try {
      peripheral = await advertisement.connect();
    } catch (err) {
      // The unit accepts one Bluetooth connection: usually the BLUETTI phone app holds it.
      throw new Error(`${err.message} (is the BLUETTI app connected to it over Bluetooth?)`);
    }
    let subscribed = null;
    try {
      const { notify, write } = await this._characteristics(peripheral);
      const session = new BluettiSession(this.sessionOptions);
      const link = new Link({ session, write, log: this.log });
      subscribed = notify;
      await notify.subscribeToNotifications((data) => link.onNotify(Buffer.from(data)));
      link.start();

      const handshakeStart = Date.now();
      await link.waitReady(HANDSHAKE_TIMEOUT_MS);
      this.log(`BLE handshake done in ${Date.now() - handshakeStart} ms (${link.frames} frames: ${session.trace.join(' ')}; ${link.duplicates} duplicate notifications ignored)`);
      await link.waitQuiet(QUIET_MS, QUIET_MAX_MS);

      try {
        return await fn(link);
      } catch (err) {
        if (!err.modbusException) err.message = `${err.message}; frames: ${session.trace.join(' ')}`;
        throw err;
      }
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
    // Diagnostics: notifications and complete frames seen on this link.
    this.chunks = 0;
    this.frames = 0;
    this.lastNotifyAt = 0;
    this.duplicates = 0;
    this._lastChunk = null;
    // One GATT write at a time: an answer can arrive before its write has completed.
    this._writes = Promise.resolve();
    this.pending = null;
    this.error = null;
    this._readyWaiters = [];
    // The unit sends its challenge while subscribing is still in flight, and Homey allows one GATT
    // operation at a time ("In Progress"): hold notifications until start(), then handle them in order.
    this._started = null;
    this._queue = new Promise((resolve) => { this._started = resolve; });
  }

  start() {
    this._started();
  }

  onNotify(chunk) {
    const now = Date.now();
    if (this._lastChunk && now - this.lastNotifyAt < DUPLICATE_WINDOW_MS && chunk.equals(this._lastChunk)) {
      this.duplicates += 1;
      return;
    }
    this._lastChunk = chunk;
    this.chunks += 1;
    this.lastNotifyAt = now;
    this._queue = this._queue.then(() => this._consume(chunk)).catch((err) => this._fail(err));
  }

  async _consume(chunk) {
    // A handshake frame in clear text always arrives on its own.
    if (this.buffer.length === 0 && BluettiSession.isKexFrame(chunk)) {
      this.frames += 1;
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
      this.frames += 1;

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
    if (all.length < 2) return;
    // Exception reply: [addr][fn | 0x80][code][crc lo][crc hi]
    if (all[1] & 0x80) {
      const err = new Error(`MODBUS exception ${all[2]}`);
      err.modbusException = true;
      this._settle(err);
      return;
    }
    // Write reply echoes the command: [addr][6][reg hi][reg lo][value hi][value lo][crc lo][crc hi].
    // Read reply: [addr][3][byteCount][data...][crc lo][crc hi].
    const isWrite = all[1] === 0x06;
    if (!isWrite && all.length < 3) return;
    const length = isWrite ? 8 : all[2] + 5;
    if (all.length < length) return;
    const frame = all.subarray(0, length);
    const crc = frame.readUInt16LE(frame.length - 2);
    if (crc !== modbusCrc(frame.subarray(0, frame.length - 2))) {
      this._settle(new Error('MODBUS CRC mismatch'));
      return;
    }
    this._settle(null, frame.subarray(isWrite ? 4 : 3, frame.length - 2));
  }

  _write(data) {
    const write = this._writes.then(() => this.writeChar.write(data));
    this._writes = write.catch(() => {});
    return write;
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

  // Resolves once no notification arrived for quietMs and all received ones are handled (at most maxMs).
  async waitQuiet(quietMs, maxMs) {
    const end = Date.now() + maxMs;
    for (;;) {
      await this._queue;
      const idle = Date.now() - this.lastNotifyAt;
      if (idle >= quietMs || Date.now() >= end) return;
      await new Promise((r) => setTimeout(r, Math.min(quietMs - idle, end - Date.now())));
    }
  }

  request(command, timeoutMs) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const before = { chunks: this.chunks, frames: this.frames };
      const timer = setTimeout(() => this._settle(new Error('No answer from power station'
        + ` (after the request: ${this.chunks - before.chunks} notifications, ${this.frames - before.frames} frames,`
        + ` ${this.buffer.length} bytes waiting)`)), timeoutMs);
      this.pending = { chunks: [], resolve, reject, timer };
      // Like bluetti-bt-lib: start each answer on an empty buffer, after what is already queued.
      const cleared = this._queue.then(() => {
        if (this.buffer.length) this.log(`BLE dropped ${this.buffer.length} stray bytes`);
        this.buffer = Buffer.alloc(0);
      });
      this._queue = cleared;
      cleared.then(() => this._write(this.session.encrypt(command))).catch((err) => this._settle(err));
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

module.exports = {
  BluettiBleReader, modbusCrc, readCommand, writeCommand, matchesSerial,
};
