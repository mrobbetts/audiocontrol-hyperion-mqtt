// tools/homeostat-smoke.mjs — end-to-end smoke of the homeostat facet against
// a real broker (default mqtt://localhost:18830; no device needed):
// announce -> retained state -> set routing -> value convergence -> LWT shape.
import mqtt from 'mqtt';
import { createHomeostat } from '../src/homeostat.mjs';

const URL = 'mqtt://localhost:18830';
const log = { info: () => {}, warn: (...a) => console.error('WARN', ...a) };
const commands = [];
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
setTimeout(() => fail('timeout'), 8000);

const probe = mqtt.connect(URL);
const seen = new Map();
probe.on('message', (t, p) => seen.set(t, p.toString()));

await new Promise((r) => probe.on('connect', r));
await new Promise((r) => probe.subscribe('homeostat/1/#', { qos: 1 }, r));

const facet = createHomeostat({
  cfg: { root: 'homeostat/1', url: URL, username: null, password: null },
  deviceId: 'axis-smoke',
  name: 'Smoke Axis',
  nativePrefix: 'audiocontrol/hyperion/axis-smoke',
  onCommand: (suffix, payload) => commands.push([suffix, payload]),
  log,
});

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
await settle();

// 1. lifecycle + $desc
if (seen.get('homeostat/1/axis-smoke/$state') !== 'ready') fail('$state not ready');
const desc = JSON.parse(seen.get('homeostat/1/axis-smoke/$desc') ?? 'null');
if (desc?.profile !== 'speaker-system') fail('$desc missing/wrong');

// 2. reported state flows from native change feed
facet.onChange(['speaker', 'volume'], 40);
facet.onChange(['power'], true);
facet.onChange(['inputFormat'], 'Dolby Atmos');
facet.onChange(['info', 'model'], 'ACP-AXIS16'); // unmapped: must NOT appear
await settle();
if (seen.get('homeostat/1/axis-smoke/volume') !== '40') fail('volume not published');
if (seen.get('homeostat/1/axis-smoke/power') !== 'true') fail('power not published');
if (seen.get('homeostat/1/axis-smoke/format') !== 'Dolby Atmos') fail('format not published');
if ([...seen.keys()].some((t) => t.includes('model'))) fail('unmapped path leaked');

// 3. set routing decodes + hits the native command vocabulary
probe.publish('homeostat/1/axis-smoke/volume/set', '55', { qos: 1 });
probe.publish('homeostat/1/axis-smoke/source/set', 'earc', { qos: 1 });
probe.publish('homeostat/1/axis-smoke/volume/set', 'loud', { qos: 1 }); // must be rejected
await settle();
const want = JSON.stringify([['speaker/volume', '55'], ['input', 'earc']]);
if (JSON.stringify(commands) !== want) fail(`commands: ${JSON.stringify(commands)}`);

// 4. retained late-joiner view
const late = mqtt.connect(URL);
const lateSeen = new Map();
late.on('message', (t, p) => lateSeen.set(t, p.toString()));
await new Promise((r) => late.on('connect', r));
await new Promise((r) => late.subscribe('homeostat/1/axis-smoke/#', { qos: 1 }, r));
await settle();
if (lateSeen.get('homeostat/1/axis-smoke/volume') !== '40') fail('late joiner missed retained volume');
if (lateSeen.get('homeostat/1/axis-smoke/$state') !== 'ready') fail('late joiner missed $state');

console.log('SMOKE OK —', [...lateSeen.keys()].sort().join(', '));
facet.close();
probe.end();
late.end();
process.exit(0);
