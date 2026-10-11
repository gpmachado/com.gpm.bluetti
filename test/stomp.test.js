'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { BluettiStomp } = require('../lib/BluettiStomp');

// A token refresh while connecting calls restart(); only one socket may end up open.
test('restart during connect opens a single WebSocket', { timeout: 5000 }, async () => {
  const server = new WebSocket.Server({ port: 0 });
  await new Promise((r) => server.on('listening', r));
  let connections = 0;
  server.on('connection', (ws) => {
    connections += 1;
    ws.on('message', (m) => {
      if (String(m).startsWith('CONNECT')) ws.send('CONNECTED\nversion:1.2\nuser-name:u1\n\n\0');
    });
  });

  let calls = 0;
  const stomp = new BluettiStomp({
    log: () => {},
    error: () => {},
    getConnectInfo: async () => {
      calls += 1;
      // Simulates the token being refreshed (which restarts the link) during the first connect.
      if (calls === 1) stomp.restart();
      await new Promise((r) => setTimeout(r, 20));
      return { url: `ws://127.0.0.1:${server.address().port}/ws`, token: 't', headers: {} };
    },
  });
  stomp.start();
  await new Promise((r) => setTimeout(r, 500));
  stomp.stop();
  for (const client of server.clients) client.terminate();
  server.close();
  assert.strictEqual(connections, 1);
});
