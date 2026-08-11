// homeostat.mjs — publishes each unit as a homeostat/1 `source-processor`
// capability device (see the homeostat repo's SPEC.md), alongside the native
// status/set surface. The Axis selects and decodes; it makes no sound — its
// volume/mute are TRIMS, never room-level candidates (that's the profile's
// promise; it was the misfit that motivated `source-processor`). The facet gets its OWN mqtt connection: a connection
// carries exactly one LWT, the bridge's is spent on bridge/status, and each
// capability device needs $state -> lost on ungraceful death.
//
// Mapping is deliberately the panel's common denominator; everything else
// (downmix, per-input decode modes, trims, ...) stays native-only.

import mqtt from 'mqtt';
import { randomBytes } from 'node:crypto';
import { createFacet, willFor } from 'homeostat';

// native state path (joined) -> capability property
export const PATH_TO_PROP = Object.freeze({
  power: 'power',
  'speaker/volume': 'volume',
  'speaker/mute': 'mute',
  input: 'source',
  inputFormat: 'format',
  connected: 'online',
});

// capability property -> native set suffix (device.mjs routeSet vocabulary)
export const PROP_TO_SUFFIX = Object.freeze({
  power: 'power',
  volume: 'speaker/volume',
  mute: 'speaker/mute',
  source: 'input',
});

export const descFor = ({ name, area, instance, nativePrefix }) => ({
  schema: 'homeostat/1',
  version: 1,
  profile: 'source-processor',
  name,
  ...(area ? { area } : {}),
  vendor: 'AudioControl',
  instance,
  bridge: { name: 'audiocontrol-hyperion-mqtt' },
  native: { prefix: nativePrefix, protocol: 'audiocontrol-hyperion-mqtt/1' },
  properties: {
    power: { type: 'boolean', settable: true },
    volume: { type: 'float', format: '0:100:1', unit: '%', settable: true },
    mute: { type: 'boolean', settable: true },
    source: { type: 'enum', format: 'earc,digital', settable: true, labels: { earc: 'eARC', digital: 'Digital' } },
    format: { type: 'string' },
    online: { type: 'boolean' },
  },
});

// createHomeostat wires one facet device. onCommand(suffix, payload) receives
// the native command vocabulary; reported state converges via onChange when
// the device confirms (poll or command echo) — never optimistically.
export const createHomeostat = ({ cfg, deviceId, name, area, nativePrefix, onCommand, log }) => {
  const instance = randomBytes(4).toString('hex');
  const root = cfg.root;
  const client = mqtt.connect(cfg.url, {
    clientId: `homeostat-${deviceId}-${instance}`,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    reconnectPeriod: 2000,
    will: willFor(deviceId, root),
  });

  const facet = createFacet({
    client,
    deviceId,
    root,
    desc: descFor({ name, area, instance, nativePrefix }),
    onSet: (prop, value) => {
      const suffix = PROP_TO_SUFFIX[prop];
      if (!suffix) return false;
      log.info('homeostat set', { prop, value });
      onCommand(suffix, String(value));
    },
    onTwin: (info) => log.warn('homeostat TWIN detected — second bridge on this device id?', info),
    onBadSet: ({ prop, error }) => log.warn('homeostat bad set', { prop, error }),
  });
  if (!facet.ok) throw new Error(`homeostat $desc invalid: ${facet.errors.join('; ')}`);

  client.on('connect', () => {
    facet.start();
    facet.ready();
    log.info('homeostat facet ready', { root, deviceId });
  });
  client.on('error', (err) => log.warn('homeostat mqtt error', { err: err.message }));

  return {
    onChange: (path, value) => {
      const prop = PATH_TO_PROP[path.join('/')];
      if (prop) facet.publishValue(prop, value);
    },
    close: (cb) => {
      facet.stop();
      client.end(false, {}, cb);
    },
  };
};
