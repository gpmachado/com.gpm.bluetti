'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const https = require('https');
const { EventEmitter } = require('events');

// BluettiCloud reads its keys from require('homey').env, which only exists on Homey.
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { env: { BLUETTI_CLIENT_SECRET: 's', BLUETTI_APP_KEY: 'k' } };
  return realLoad.call(this, request, ...rest);
};
const { BluettiCloud } = require('../lib/BluettiCloud');

Module._load = realLoad;

// Fakes https.request: `hosts` maps hostname → 'timeout' or { status, json }.
let seenTimeouts = [];
function fakeHttps(hosts) {
  const seen = [];
  seenTimeouts = [];
  https.request = (url, opts, onRes) => {
    const { hostname } = new URL(url);
    seen.push(hostname);
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = (err) => setImmediate(() => req.emit('error', err));
    req.end = () => setImmediate(() => {
      const r = hosts[hostname];
      seenTimeouts.push(opts.timeout);
      if (r === 'timeout') return req.emit('timeout');
      const res = new EventEmitter();
      res.statusCode = r.status;
      onRes(res);
      res.emit('data', Buffer.from(JSON.stringify(r.json)));
      res.emit('end');
    });
    return req;
  };
  return seen;
}

function makeCloud(host) {
  const store = { oauth_token: { access_token: 'a', host, expires_at: Date.now() + 3600000 } };
  return new BluettiCloud({
    homey: { settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; }, unset: () => {} } },
    log: () => {},
  });
}

const OK = { status: 200, json: { msgCode: 0, data: [{ sn: '1' }] } };

test('switches REST to the regional host when the gateway times out, and stays there', async () => {
  const seen = fakeHttps({ 'gw.bluettipower.com': 'timeout', 'eu.example.com': OK });
  const cloud = makeCloud('https://eu.example.com/');
  assert.deepStrictEqual(await cloud.getDeviceStates(['1']), [{ sn: '1' }]);
  assert.strictEqual(cloud.restHost(), 'eu.example.com');
  await cloud.getDeviceStates(['1']);
  assert.deepStrictEqual(seen, ['gw.bluettipower.com', 'eu.example.com', 'eu.example.com']);
});

test('does not switch to a host that does not serve the API', async () => {
  fakeHttps({ 'gw.bluettipower.com': 'timeout', 'eu.example.com': { status: 404, json: null } });
  const cloud = makeCloud('https://eu.example.com');
  await assert.rejects(cloud.getDeviceStates(['1']), /timed out/);
  assert.strictEqual(cloud.restHost(), 'gw.bluettipower.com');
});

test('without a regional host the timeout is reported as before', async () => {
  const seen = fakeHttps({ 'gw.bluettipower.com': 'timeout' });
  const cloud = makeCloud(null);
  await assert.rejects(cloud.getDeviceStates(['1']), /timed out/);
  assert.deepStrictEqual(seen, ['gw.bluettipower.com']);
});

test('a command stays within Homey\'s 10 s limit', async () => {
  fakeHttps({ 'gw.bluettipower.com': OK });
  await makeCloud(null).control('1', 'SetCtrlDc', 1);
  assert.ok(seenTimeouts[0] <= 8000, `timeout ${seenTimeouts[0]}`);
});
