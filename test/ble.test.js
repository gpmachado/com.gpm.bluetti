'use strict';

// Simulated encrypted ("V2") BLUETTI power station on a fake Homey BLE API.
// Covers the handshake, AES framing, 20-byte notification fragments and MODBUS reads.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  aesEncrypt, aesDecrypt, hexsum, encryptedFrameLength,
} = require('../lib/ble/BluettiCrypto');
const { BluettiBleReader, modbusCrc, readCommand } = require('../lib/ble/BluettiBleReader');

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

const REGISTERS = { 102: 87, 104: 1986, 140: 0, 142: 197, 144: 0, 146: 374 };

function simulatedPowerStation() {
  const challenge = crypto.randomBytes(4);
  const iv = md5(Buffer.from(challenge).reverse());
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) key[i] = iv[i] ^ LOCAL_KEY[i];
  const ecdh = crypto.createECDH('prime256v1');
  const devPub = ecdh.generateKeys().subarray(1);
  let secure = null;
  let notify;
  let rx = Buffer.alloc(0);

  // Notifications arrive in 20-byte pieces, like over a default-MTU BLE link.
  const send = (buf) => {
    for (let i = 0; i < buf.length; i += 20) {
      const chunk = buf.subarray(i, i + 20);
      setImmediate(() => notify(chunk));
    }
  };

  const onWrite = (data) => {
    if (data[0] === 0x2a && data[1] === 0x2a) {
      assert.ok(data.subarray(4, 8).equals(iv.subarray(8, 12)), 'challenge reply');
      send(kex(Buffer.from('030100', 'hex')));
      const sig = crypto.sign('sha256', Buffer.concat([devPub, iv]), { key: k2.privateKey, dsaEncoding: 'ieee-p1363' });
      setImmediate(() => send(aesEncrypt(kex(Buffer.concat([Buffer.from('0480', 'hex'), devPub, sig])), key, iv)));
      return;
    }
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
      return;
    }
    const cmd = aesDecrypt(frame, secure, null);
    assert.strictEqual(modbusCrc(cmd.subarray(0, 6)), cmd.readUInt16LE(6), 'command CRC');
    const resp = Buffer.alloc(7);
    resp[0] = 1;
    resp[1] = 3;
    resp[2] = 2;
    resp.writeUInt16BE(REGISTERS[cmd.readUInt16BE(2)] || 0, 3);
    resp.writeUInt16LE(modbusCrc(resp.subarray(0, 5)), 5);
    send(aesEncrypt(resp, secure, null));
  };

  const notifyChar = {
    uuid: '0000ff01-0000-1000-8000-00805f9b34fb',
    subscribeToNotifications: async (cb) => {
      notify = cb;
      send(kex(Buffer.concat([Buffer.from('0104', 'hex'), challenge])));
    },
    unsubscribeFromNotifications: async () => {},
  };
  const writeChar = { uuid: '0000ff02-0000-1000-8000-00805f9b34fb', write: async (d) => onWrite(Buffer.from(d)) };
  const peripheral = {
    discoverAllServicesAndCharacteristics: async () => [{ uuid: 'ff00', characteristics: [notifyChar, writeChar] }],
    disconnect: async () => {},
  };
  return {
    localName: 'EL30V22622110380002', uuid: 'e83dc108120a', rssi: -48, connect: async () => peripheral,
  };
}

test('MODBUS read commands match bluetti-bt-lib', () => {
  assert.strictEqual(readCommand(102, 1).toString('hex'), '0103006600016415');
  assert.strictEqual(readCommand(1314, 1).toString('hex'), '01030522000124cc');
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
