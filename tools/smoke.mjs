#!/usr/bin/env node
// tools/smoke.mjs — read-only live smoke test against a real device.
//
// Usage: node tools/smoke.mjs <host> [port]
//
// Exercises the production transport + codec + reducer (no MQTT): connects,
// runs the full GET sweep, prints the assembled state as JSON, then holds the
// line open listening for unsolicited traffic before exiting. Sends only GET
// commands — never mutates device state.

import { createTransport } from '../src/transport.mjs';
import { parse } from '../src/codec.mjs';
import { applyEvent, initialState } from '../src/state.mjs';
import { polls } from '../src/protocol.mjs';
import { makeLogger } from '../src/log.mjs';

const [host, port = '23'] = process.argv.slice(2);
if (!host) {
  console.error('usage: smoke.mjs <host> [port]');
  process.exit(2);
}

const LISTEN_MS = 20_000;
const log = makeLogger(process.env.LOG_LEVEL ?? 'info', 'smoke');

let state = initialState;
let sweeping = true;
const unparsed = [];
const unsolicited = [];

const transport = createTransport({
  host,
  port: Number(port),
  command: { timeoutMs: 3000, retries: 0 },
  reconnect: { minMs: 500, maxMs: 500, factor: 1 },
  log,
  onLine: (line) => {
    if (!sweeping) unsolicited.push(line);
    const event = parse(line);
    if (!event) {
      if (sweeping) unparsed.push(line);
      return;
    }
    state = applyEvent(state, event).state;
  },
  onConnectedChange: async (up) => {
    if (!up) return;
    for (const q of polls.full) await transport.send(q, null);
    sweeping = false;

    console.log(JSON.stringify(state, null, 2));
    if (unparsed.length) {
      console.error(`--- lines the codec did not recognize ---`);
      for (const l of unparsed) console.error(`  ${JSON.stringify(l)}`);
    }
    console.error(`--- holding line open ${LISTEN_MS / 1000}s: change volume/input on the WebUI NOW to test unsolicited push ---`);
    setTimeout(() => {
      console.error(unsolicited.length
        ? `UNSOLICITED LINES RECEIVED (device pushes!):\n${unsolicited.map((l) => `  ${JSON.stringify(l)}`).join('\n')}`
        : 'no unsolicited lines received in the window (assume polling required)');
      transport.stop();
      process.exit(0);
    }, LISTEN_MS);
  },
});

transport.start();
setTimeout(() => { log.error('timed out'); process.exit(1); }, 90_000);
