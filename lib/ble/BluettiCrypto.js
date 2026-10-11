'use strict';

// Crypto for the encrypted ("V2") BLUETTI BLE protocol.
// Port of bluetti_bt_lib/bluetooth/encryption.py (Patrick762/bluetti-bt-lib), itself based on
// nhurman/bluetti_mqtt; cross-checked against Garfonso/ioBroker.bluetti-ble (MIT).
// The static keys are published in BLUETTI apps/firmware: they obfuscate, they do not secure.

const crypto = require('crypto');

const LOCAL_AES_KEY = Buffer.from('459FC535808941F17091E0993EE3E93D', 'hex');
const SIGN_PRIVATE_KEY = Buffer.from('4F19A16E3E87BDD9BD24D3E5495B88041511943CBC8B969ADE9641D0F56AF337', 'hex');
const PEER_SIGN_PUBLIC_KEY_DER = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d03010703420004'
  + 'A73ABF5D2232C8C1C72E68304343C272495E3A8FD6F30EA96DE2F4B3CE60B251'
  + 'EE21AC667CF8A71E18B46B664EAEFFE3C489F24F695B6411DB7E22CCC85A8594',
  'hex',
);

const KEX_MAGIC = Buffer.from('2a2a', 'hex'); // "**"
const AES_BLOCK = 16;

const MessageType = {
  CHALLENGE: 1,
  CHALLENGE_ACCEPTED: 3,
  PEER_PUBKEY: 4,
  PUBKEY_ACCEPTED: 6,
};

const md5 = (data) => crypto.createHash('md5').update(data).digest();

function hexsum(data, size) {
  let sum = 0;
  for (const b of data) sum += b;
  const out = Buffer.alloc(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = sum & 0xff;
    sum = Math.floor(sum / 256);
  }
  return out;
}

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

const aesAlgo = (key) => (key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc');

// Layout: [len:u16be][iv-seed:4 when iv is null][ciphertext, zero padded]
function aesDecrypt(data, key, iv) {
  const len = data.readUInt16BE(0);
  let realIv = iv;
  let encrypted;
  if (!realIv) {
    realIv = md5(data.subarray(2, 6));
    encrypted = data.subarray(6);
  } else {
    encrypted = data.subarray(2);
  }
  if (encrypted.length % AES_BLOCK !== 0) throw new Error('Data not aligned on AES block size');
  const decipher = crypto.createDecipheriv(aesAlgo(key), key, realIv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).subarray(0, len);
}

function aesEncrypt(data, key, iv) {
  let header = Buffer.alloc(2);
  header.writeUInt16BE(data.length, 0);
  let realIv = iv;
  if (!realIv) {
    const seed = crypto.randomBytes(4);
    realIv = md5(seed);
    header = Buffer.concat([header, seed]);
  }
  const pad = (AES_BLOCK - (data.length % AES_BLOCK)) % AES_BLOCK;
  const cipher = crypto.createCipheriv(aesAlgo(key), key, realIv);
  cipher.setAutoPadding(false);
  return Buffer.concat([header, cipher.update(Buffer.concat([data, Buffer.alloc(pad)])), cipher.final()]);
}

// Full expected size of an encrypted frame whose first bytes are in `buffer`.
function encryptedFrameLength(buffer, secure) {
  if (buffer.length < 2) return null;
  const len = buffer.readUInt16BE(0);
  const padded = Math.ceil(len / AES_BLOCK) * AES_BLOCK;
  return (secure ? 6 : 2) + padded;
}

function signingKey() {
  // SEC1 ECPrivateKey for P-256 built from the raw scalar.
  const der = Buffer.concat([
    Buffer.from('30310201010420', 'hex'),
    SIGN_PRIVATE_KEY,
    Buffer.from('a00a06082a8648ce3d030107', 'hex'),
  ]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' });
}

function kexFrame(body) {
  return Buffer.concat([KEX_MAGIC, body, hexsum(body, 2)]);
}

// Handshake state machine. Feed it complete frames; it returns bytes to write back (or null).
class BluettiSession {

  // peerSignKeyDer is only overridden by tests (a simulated power station).
  constructor({ peerSignKeyDer = PEER_SIGN_PUBLIC_KEY_DER } = {}) {
    this.peerSignKeyDer = peerSignKeyDer;
    this.unsecureKey = null;
    this.unsecureIv = null;
    this.secureKey = null;
    this._ecdh = null;
    this._peerPub = null;
  }

  get ready() {
    return Boolean(this.secureKey);
  }

  static isKexFrame(buf) {
    return buf.length >= 2 && buf[0] === 0x2a && buf[1] === 0x2a;
  }

  // Plain "**" frame from the device.
  handlePlain(frame) {
    const body = frame.subarray(2, frame.length - 2);
    if (!hexsum(body, 2).equals(frame.subarray(frame.length - 2))) throw new Error('Handshake checksum mismatch');
    const type = body[0];
    const data = body.subarray(2);
    if (type === MessageType.CHALLENGE) {
      if (data.length !== 4) throw new Error('Unexpected challenge length');
      this.unsecureIv = md5(Buffer.from(data).reverse());
      this.unsecureKey = xor(this.unsecureIv, LOCAL_AES_KEY);
      return kexFrame(Buffer.concat([Buffer.from('0204', 'hex'), this.unsecureIv.subarray(8, 12)]));
    }
    if (type === MessageType.CHALLENGE_ACCEPTED) return null;
    throw new Error(`Unexpected handshake message ${type}`);
  }

  // Encrypted frame from the device. Returns { reply } during the handshake or { data } afterwards.
  handleEncrypted(frame) {
    if (!this.unsecureKey) throw new Error('Encrypted data before handshake');
    const plain = this.secureKey
      ? aesDecrypt(frame, this.secureKey, null)
      : aesDecrypt(frame, this.unsecureKey, this.unsecureIv);

    if (!BluettiSession.isKexFrame(plain)) return { data: plain };

    const body = plain.subarray(2, plain.length - 2);
    if (!hexsum(body, 2).equals(plain.subarray(plain.length - 2))) throw new Error('Handshake checksum mismatch');
    const type = body[0];
    const data = body.subarray(2);

    if (type === MessageType.PEER_PUBKEY) {
      if (data.length !== 128) throw new Error('Unexpected peer key length');
      const pub = data.subarray(0, 64);
      const signature = data.subarray(64);
      const verifyKey = crypto.createPublicKey({ key: this.peerSignKeyDer, format: 'der', type: 'spki' });
      const ok = crypto.verify('sha256', Buffer.concat([pub, this.unsecureIv]),
        { key: verifyKey, dsaEncoding: 'ieee-p1363' }, signature);
      if (!ok) throw new Error('Power station key signature is invalid');
      this._peerPub = Buffer.concat([Buffer.from([0x04]), pub]);

      this._ecdh = crypto.createECDH('prime256v1');
      const myPub = this._ecdh.generateKeys().subarray(1); // drop 0x04
      const mySig = crypto.sign('sha256', Buffer.concat([myPub, this.unsecureIv]),
        { key: signingKey(), dsaEncoding: 'ieee-p1363' });
      const msg = kexFrame(Buffer.concat([Buffer.from('0580', 'hex'), myPub, mySig]));
      return { reply: aesEncrypt(msg, this.unsecureKey, this.unsecureIv) };
    }
    if (type === MessageType.PUBKEY_ACCEPTED) {
      if (data.length !== 1 || data[0] !== 0) throw new Error('Power station rejected our key');
      this.secureKey = this._ecdh.computeSecret(this._peerPub);
      return {};
    }
    throw new Error(`Unexpected handshake message ${type}`);
  }

  encrypt(data) {
    return aesEncrypt(data, this.secureKey, null);
  }

}

module.exports = {
  BluettiSession, encryptedFrameLength, aesEncrypt, aesDecrypt, hexsum, KEX_MAGIC,
};
