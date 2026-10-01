import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTransport } from '../src/transport.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10); } };

// a unit that accepts connections; `answer` decides what (if anything) a line gets back
const fakeUnit = async (answer) => {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.setEncoding('utf8');
    s.on('data', (d) => d.split('\r\n').filter(Boolean).forEach((line) => { seen.push(line); const r = answer(line); if (r) s.write(r + '\r\n'); }));
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, drop: () => sockets.forEach((s) => s.destroy()), close: () => { sockets.forEach((s) => s.destroy()); server.close(); } };
};
const transportFor = (unit, over = {}) => {
  const edges = [];
  const t = createTransport({
    host: '127.0.0.1', port: unit.port, log: quiet,
    command: { timeoutMs: 200, retries: 0, silenceMs: 150, ...over },
    reconnect: { minMs: 60, maxMs: 60, factor: 1 },
    onConnectedChange: (up) => edges.push(up),
  });
  return { t, edges };
};

test('a command sent while disconnected is refused, not parked — and the link is idle on reconnect', async () => {
  const unit = await fakeUnit((line) => line.replace(/^(GET|SET) /, ''));
  const { t, edges } = transportFor(unit, { silenceMs: 60_000 });
  t.start();
  await until(() => t.isConnected());
  unit.drop();
  await until(() => edges.includes(false));
  assert.equal(await t.send('SET POWER ON', /^POWER/), false);
  await until(() => t.isConnected());
  assert.equal(t.isIdle(), true, 'nothing parked: the reconnect re-sync is not skipped as "busy"');
  await sleep(120);
  assert.ok(!unit.seen.includes('SET POWER ON'), 'the dropped command never fires as a ghost');
  assert.equal(await t.send('GET POWER', /^POWER/), true);
  t.stop();
  unit.close();
});

test('a unit that accepts the socket and answers nothing is recycled (online drops)', async () => {
  const unit = await fakeUnit(() => null);
  const { t, edges } = transportFor(unit);
  t.start();
  await until(() => t.isConnected());
  t.send('GET POWER'); // asked...
  await until(() => edges.includes(false)); // ...heard nothing: the socket is torn down
  await until(() => edges.filter((e) => e).length >= 2); // and tried again
  t.stop();
  unit.close();
});

test('a quiet link nobody is asking on is not silence', async () => {
  const unit = await fakeUnit((line) => line);
  const { t, edges } = transportFor(unit);
  t.start();
  await until(() => t.isConnected());
  assert.equal(await t.send('GET POWER', /^GET POWER/), true);
  await sleep(500); // > 3 silence windows with nothing asked
  assert.deepEqual(edges, [true]);
  t.stop();
  unit.close();
});
