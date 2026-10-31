'use strict';

// Simulated encrypted ("V2") BLUETTI power station on a fake Homey BLE API.
// Covers the handshake, AES framing, 20-byte notification fragments and MODBUS reads.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  aesEncrypt, aesDecrypt, hexsum, encryptedFrameLength,
} = require('../lib/ble/BluettiCrypto');
const {
  BluettiBleReader, modbusCrc, readCommand, writeCommand,
} = require('../lib/ble/BluettiBleReader');

const LOCAL_KEY = Buffer.from('459FC535808941F17091E0993EE3E93D', 'hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest();
const kex = (body) => Buffer.concat([Buffer.from('2a2a', 'hex'), body, hexsum(body, 2)]);
// The power station signs its key with K2; we do not have that private key, so the test
// uses its own pair and passes the public half to the session.
const k2 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const homeySignPub = (() => {
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(Buffer.from('4F19A16E3E87BDD9BD24D3E5495B88041511943CBC8B969ADE9641D0F56AF337', 'hex'));
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), e.getPublicKey()]),
    format: 'der',
    type: 'spki',
  });
})();

const REGISTERS = {
  102: 87, 104: 1986, 140: 0, 142: 197, 144: 0, 146: 374, 2011: 1, 2012: 0, 2014: 0, 2017: 1,
};

function simulatedPowerStation({
  gattDelayMs = 0, strayAfterHandshake = false, repeatPeerKey = false, copies = 1, ackDelayMs = 0, outputs = true, applyDelayMs = 0,
} = {}) {
  const registers = { ...REGISTERS };
  const challenge = crypto.randomBytes(4);
  const iv = md5(Buffer.from(challenge).reverse());
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) key[i] = iv[i] ^ LOCAL_KEY[i];
  const ecdh = crypto.createECDH('prime256v1');
  const devPub = ecdh.generateKeys().subarray(1);
  let secure = null;
  let notify;
  // Like Homey's BLE stack: one GATT operation at a time, another one meanwhile fails with "In Progress".
  let writing = false;
  let rx = Buffer.alloc(0);

  // Notifications arrive in 20-byte pieces, like over a default-MTU BLE link.
  const send = (buf) => {
    for (let i = 0; i < buf.length; i += 20) {
      const chunk = buf.subarray(i, i + 20);
      for (let c = 0; c < copies; c++) setImmediate(() => notify(Buffer.from(chunk)));
    }
  };

  const onWrite = (data) => {
    if (data[0] === 0x2a && data[1] === 0x2a) {
      assert.ok(data.subarray(4, 8).equals(iv.subarray(8, 12)), 'challenge reply');
      send(kex(Buffer.from('030100', 'hex')));
      const sig = crypto.sign('sha256', Buffer.concat([devPub, iv]), { key: k2.privateKey, dsaEncoding: 'ieee-p1363' });
      const peerKey = aesEncrypt(kex(Buffer.concat([Buffer.from('0480', 'hex'), devPub, sig])), key, iv);
      setImmediate(() => send(peerKey));
      if (repeatPeerKey) setImmediate(() => send(peerKey));
      return;
    }
    // The unit keeps the first key reply; a later one (146 bytes, a command is 22) is ignored.
    if (secure && data.length === 146) return;
    rx = Buffer.concat([rx, data]);
    const expected = encryptedFrameLength(rx, Boolean(secure));
    if (rx.length < expected) return;
    const frame = rx.subarray(0, expected);
    rx = rx.subarray(expected);
    if (!secure) {
      const plain = aesDecrypt(frame, key, iv);
      const body = plain.subarray(2, plain.length - 2);
      const pub = body.subarray(2, 66);
      const ok = crypto.verify('sha256', Buffer.concat([pub, iv]),
        { key: homeySignPub, dsaEncoding: 'ieee-p1363' }, body.subarray(66, 130));
      assert.ok(ok, 'Homey signature');
      send(aesEncrypt(kex(Buffer.from('060100', 'hex')), key, iv));
      secure = ecdh.computeSecret(Buffer.concat([Buffer.from([4]), pub]));
      if (strayAfterHandshake) {
        // The start of a frame that never completes (its header announces 100 bytes), in two pieces.
        const stray = Buffer.concat([Buffer.from('0064', 'hex'), crypto.randomBytes(12)]);
        setTimeout(() => notify(stray.subarray(0, 8)), 20);
        setTimeout(() => notify(stray.subarray(8)), 60);
      }
      return;
    }
    const cmd = aesDecrypt(frame, secure, null);
    assert.strictEqual(modbusCrc(cmd.subarray(0, 6)), cmd.readUInt16LE(6), 'command CRC');
    const address = cmd.readUInt16BE(2);
    let resp;
    if (address >= 2000 && !outputs) {
      // Illegal data address
      resp = Buffer.from([1, cmd[1] | 0x80, 2, 0, 0]);
      resp.writeUInt16LE(modbusCrc(resp.subarray(0, 3)), 3);
    } else if (cmd[1] === 6) {
      const value = cmd.readUInt16BE(4);
      if (applyDelayMs) setTimeout(() => { registers[address] = value; }, applyDelayMs);
      else registers[address] = value;
      resp = Buffer.from(cmd.subarray(0, 8));
    } else {
      resp = Buffer.alloc(7);
      resp[0] = 1;
      resp[1] = 3;
      resp[2] = 2;
      resp.writeUInt16BE(registers[address] || 0, 3);
      resp.writeUInt16LE(modbusCrc(resp.subarray(0, 5)), 5);
    }
    send(aesEncrypt(resp, secure, null));
  };

  const notifyChar = {
    uuid: '0000ff01-0000-1000-8000-00805f9b34fb',
    // Subscribing is itself a GATT operation; the unit sends its challenge before it completes.
    subscribeToNotifications: async (cb) => {
      notify = cb;
      writing = true;
      send(kex(Buffer.concat([Buffer.from('0104', 'hex'), challenge])));
      if (gattDelayMs) await new Promise((r) => setTimeout(r, gattDelayMs));
      writing = false;
    },
    unsubscribeFromNotifications: async () => {},
  };
  const write = async (d) => {
    if (writing) throw new Error('In Progress');
    writing = true;
    try {
      if (gattDelayMs) await new Promise((r) => setTimeout(r, gattDelayMs));
      onWrite(Buffer.from(d));
      // The answer can be on its way before the write is acknowledged.
      if (ackDelayMs) await new Promise((r) => setTimeout(r, ackDelayMs));
    } finally {
      writing = false;
    }
  };
  const writeChar = { uuid: '0000ff02-0000-1000-8000-00805f9b34fb', write };
  const peripheral = {
    discoverAllServicesAndCharacteristics: async () => [{ uuid: 'ff00', characteristics: [notifyChar, writeChar] }],
    disconnect: async () => {},
  };
  return {
    localName: 'EL30V22622110380002', uuid: 'e83dc108120a', rssi: -48, connect: async () => peripheral, registers,
  };
}

test('MODBUS commands match bluetti-bt-lib', () => {
  assert.strictEqual(readCommand(102, 1).toString('hex'), '0103006600016415');
  assert.strictEqual(readCommand(1314, 1).toString('hex'), '01030522000124cc');
  assert.strictEqual(writeCommand(2012, 1).toString('hex'), '010607dc0001' + modbusCrc(Buffer.from('010607dc0001', 'hex')).toString(16).padStart(4, '0').replace(/(..)(..)/, '$2$1'));
});

test('reads an encrypted power station end to end', async () => {
  const ad = simulatedPowerStation();
  const homey = { ble: { discover: async () => [{ localName: 'Other' }, ad], find: async () => ad } };
  const reader = new BluettiBleReader({
    homey,
    log: () => {},
    sessionOptions: { peerSignKeyDer: k2.publicKey.export({ type: 'spki', format: 'der' }) },
  });
  const found = await reader.findAdvertisement({ serial: 'EL30V22622110380002' });
  assert.strictEqual(found, ad);
  const { values } = await reader.read(found);
  assert.deepStrictEqual(values, {
    soc: 87, time_remaining_min: 1986, dc_output_power: 0, ac_output_power: 197, dc_input_power: 0, ac_input_power: 374,
  });
});

// The challenge arrives while subscribing is still in flight; the reply must wait for it.
test('waits for the subscription before answering the handshake', async () => {
  const ad = simulatedPowerStation({ gattDelayMs: 20 });
  const reader = new BluettiBleReader({
    homey: { ble: {} },
    log: () => {},
    sessionOptions: { peerSignKeyDer: k2.publicKey.export({ type: 'spki', format: 'der' }) },
  });
  const { values } = await reader.read(ad);
  assert.strictEqual(values.soc, 87);
});

// Seen on an EL30V2 without Wi-Fi: 14 bytes of an unfinished frame after the handshake made every
// answer misframed ("No answer from power station").
test('ignores a stray fragment after the handshake', async () => {
  const ad = simulatedPowerStation({ strayAfterHandshake: true });
  const lines = [];
  const reader = new BluettiBleReader({
    homey: { ble: {} },
    log: (l) => lines.push(l),
    sessionOptions: { peerSignKeyDer: k2.publicKey.export({ type: 'spki', format: 'der' }) },
  });
  const { values } = await reader.read(ad);
  assert.strictEqual(values.soc, 87);
  assert.ok(lines.includes('BLE dropped 14 stray bytes'), lines.join('\n'));
});

// If the unit sends its key twice, both replies must carry the same key pair.
test('uses one key pair when the power station repeats its key', async () => {
  const ad = simulatedPowerStation({ repeatPeerKey: true });
  const lines = [];
  const reader = new BluettiBleReader({
    homey: { ble: {} },
    log: (l) => lines.push(l),
    sessionOptions: { peerSignKeyDer: k2.publicKey.export({ type: 'spki', format: 'der' }) },
  });
  const { values } = await reader.read(ad);
  assert.strictEqual(values.soc, 87);
  assert.ok(lines.some((l) => /frames: p1 p3 e4 e4 e6/.test(l)), lines.join('\n'));
});

// Seen on a Homey Pro with an EL30V2: every notification delivered three times, and the answer
// arriving before the write that asked for it had completed.
test('handles notifications delivered three times and early answers', async () => {
  const ad = simulatedPowerStation({ copies: 3, ackDelayMs: 20 });
  const lines = [];
  const reader = new BluettiBleReader({
    homey: { ble: {} },
    log: (l) => lines.push(l),
    sessionOptions: { peerSignKeyDer: k2.publicKey.export({ type: 'spki', format: 'der' }) },
  });
  const { values } = await reader.read(ad);
  assert.deepStrictEqual(values, {
    soc: 87, time_remaining_min: 1986, dc_output_power: 0, ac_output_power: 197, dc_input_power: 0, ac_input_power: 374,
  });
  assert.ok(lines.some((l) => /frames: p1 p3 e4 e6;/.test(l)), lines.join('\n'));
});

const newReader = () => new BluettiBleReader({
  homey: { ble: {} },
  log: () => {},
  sessionOptions: { peerSignKeyDer: k2.publicKey.export({ type: 'spki', format: 'der' }) },
});

test('reads the output switches', async () => {
  const { outputs } = await newReader().read(simulatedPowerStation());
  assert.deepStrictEqual(outputs, {
    ac: true, dc: false, dc_eco: false, ac_eco: true,
  });
});

test('switches an output and reads it back', async () => {
  // One simulated connection each: the simulator does not reset its handshake state.
  // Like the EL30V2: the new state shows a moment after the write is acknowledged.
  const first = simulatedPowerStation({ copies: 3, ackDelayMs: 20, applyDelayMs: 600 });
  assert.strictEqual(await newReader().setOutput(first, 'dc', true), true);
  assert.strictEqual(first.registers[2012], 1);
  const second = simulatedPowerStation();
  assert.strictEqual(await newReader().setOutput(second, 'ac', false), false);
  assert.strictEqual(second.registers[2011], 0);
});

test('a model without output registers still reads its values', async () => {
  const { values, outputs } = await newReader().read(simulatedPowerStation({ outputs: false }));
  assert.strictEqual(values.soc, 87);
  assert.deepStrictEqual(outputs, {});
});
