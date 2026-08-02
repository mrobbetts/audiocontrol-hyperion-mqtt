// Pure codec/state tests — no deps, run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, parse } from '../src/codec.mjs';
import { applyEvent, initialState } from '../src/state.mjs';

test('encode: absolute + relative volume', () => {
  assert.equal(encode('speaker/volume', 30).wire, 'SET VOL 30');
  assert.equal(encode('speaker/volume', 250).wire, 'SET VOL 100'); // clamp
  assert.equal(encode('speaker/volumeStep', 3).wire, 'SET VOL+ 3');
  assert.equal(encode('speaker/volumeStep', -2).wire, 'SET VOL- 2');
  assert.equal(encode('downmix/volume', 25).wire, 'SET DMVOL 25');
});

test('encode: power / mute / input / modes', () => {
  assert.equal(encode('power', 'on').wire, 'SET POWER ON');
  assert.equal(encode('power', false).wire, 'SET POWER OFF');
  assert.equal(encode('speaker/mute', 'on').wire, 'SET MUTE');
  assert.equal(encode('downmix/mute', false).wire, 'SET DMUNMUTE');
  assert.equal(encode('input', 'earc').wire, 'SET INPUT EARC '); // trailing space is intentional
  assert.equal(encode('audioMode', 'dolbySurround').wire, 'SET AUDIO MODE DOLBY SURROUND');
  assert.equal(encode('downmix/follow', 'defeat').wire, 'SET DMVOL FOLLOW DEFEAT');
});

test('encode: per-input decode settings', () => {
  assert.equal(encode('twoChMode', { input: 'earc', value: 'allChStereo' }).wire, 'SET 2CH MODE EARC ALLCHSTEREO');
  assert.equal(encode('gain', { input: 'digital', value: 'med' }).wire, 'SET INPUT GAIN DIGITAL MED');
  assert.equal(encode('drc', { input: 'earc', value: 'auto' }).wire, 'SET DRC EARC AUTO');
});

test('encode: unknown command throws', () => {
  assert.throws(() => encode('nope', 1), /unknown command/);
});

test('parse: volumes disambiguate from MAX/ON', () => {
  assert.deepEqual(parse('VOL 42'), { path: ['speaker', 'volume'], value: 42 });
  assert.deepEqual(parse('DMVOL 7'), { path: ['downmix', 'volume'], value: 7 });
  assert.deepEqual(parse('MAX VOL 90'), { path: ['speaker', 'maxVolume'], value: 90 });
  assert.deepEqual(parse('ON DMVOL 30'), { path: ['downmix', 'onVolume'], value: 30 });
});

test('parse: mute / power / input / formats', () => {
  assert.deepEqual(parse('MUTE'), { path: ['speaker', 'mute'], value: true });
  assert.deepEqual(parse('DMUNMUTE'), { path: ['downmix', 'mute'], value: false });
  assert.deepEqual(parse('POWER ON'), { path: ['power'], value: true });
  assert.deepEqual(parse('INPUT EARC'), { path: ['input'], value: 'earc' });
  assert.deepEqual(parse('INPUT FORMAT Dolby Atmos'), { path: ['inputFormat'], value: 'Dolby Atmos' });
});

test('parse: per-input + defeat edge responses', () => {
  assert.deepEqual(parse('2CH MODE DIGITAL LAST'), { path: ['inputs', 'digital', 'twoChMode'], value: 'last' });
  assert.deepEqual(parse('DRC EARC AUTO'), { path: ['inputs', 'earc', 'drc'], value: 'auto' });
  assert.deepEqual(parse('VOL DEFEATED'), { path: ['speaker', 'volumeDefeated'], value: true });
  assert.deepEqual(parse('DMVOL FOLLOW DEFEAT'), { path: ['downmix', 'follow'], value: 'defeat' });
});

test('parse: junk -> null', () => {
  assert.equal(parse(''), null);
  assert.equal(parse('garbage line'), null);
});

test('state: applyEvent sets and dedupes', () => {
  const a = applyEvent(initialState, parse('VOL 42'));
  assert.equal(a.state.speaker.volume, 42);
  assert.deepEqual(a.change, { path: ['speaker', 'volume'], value: 42 });
  const b = applyEvent(a.state, parse('VOL 42')); // idempotent
  assert.equal(b.change, null);
  assert.equal(b.state, a.state); // unchanged reference
});
