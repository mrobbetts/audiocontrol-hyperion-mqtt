import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDesc } from 'homeostat';
import { descFor, PATH_TO_PROP, PROP_TO_SUFFIX } from '../src/homeostat.mjs';
import { commands } from '../src/protocol.mjs';

const desc = () =>
  descFor({ name: 'Axis16', instance: 'abcd1234', nativePrefix: 'audiocontrol/hyperion/axis16' });

test('descFor produces a valid speaker-system $desc', () => {
  const result = validateDesc(desc());
  assert.deepEqual(result.ok, true, JSON.stringify(result.errors ?? []));
});

test('every settable capability property routes to a real native command', () => {
  const properties = desc().properties;
  const settable = Object.entries(properties)
    .filter(([, def]) => def.settable === true)
    .map(([prop]) => prop);
  assert.deepEqual(settable.sort(), Object.keys(PROP_TO_SUFFIX).sort());
  for (const suffix of Object.values(PROP_TO_SUFFIX)) {
    assert.ok(commands[suffix], `native command "${suffix}" exists`);
  }
});

test('every mapped state path lands on a declared property', () => {
  const properties = desc().properties;
  for (const prop of Object.values(PATH_TO_PROP)) {
    assert.ok(properties[prop], `property "${prop}" declared in $desc`);
  }
});

test('read-only properties are fed by state, not settable', () => {
  const properties = desc().properties;
  const fed = new Set(Object.values(PATH_TO_PROP));
  for (const [prop, def] of Object.entries(properties)) {
    assert.ok(fed.has(prop), `property "${prop}" has a state source`);
    if (!def.settable) assert.ok(!PROP_TO_SUFFIX[prop], `read-only "${prop}" has no command route`);
  }
});
