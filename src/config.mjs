// config.mjs — load + validate + defaults. Config file path comes from
// AUDIOCONTROL_HYPERION_CONFIG or argv[2]. A handful of env vars override the
// file (handy for secrets injected by systemd EnvironmentFile / LoadCredential).

import { readFileSync } from 'node:fs';

const DEFAULTS = {
  mqtt: { url: 'mqtt://localhost:1883', username: null, password: null, prefix: 'audiocontrol/hyperion', clientId: 'audiocontrol-hyperion-mqtt' },
  poll: { intervalMs: 2000 },
  command: { timeoutMs: 5000, retries: 2 },
  reconnect: { minMs: 1000, maxMs: 30000, factor: 2 },
  logLevel: 'info',
  devices: [],
};

const merge = (base, over) => {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object' && base && typeof base === 'object' && !Array.isArray(base)) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
};

// Devices may be given as an array or as an { id: {...} } map (the NixOS module
// uses the map form). Normalize to an array of fully-defaulted device configs.
const normalizeDevices = (devices, cfg) => {
  const list = Array.isArray(devices)
    ? devices
    : Object.entries(devices ?? {}).map(([id, d]) => ({ id, ...d }));
  return list.map((d) => {
    if (!d.id) throw new Error('device is missing "id"');
    if (!d.host) throw new Error(`device "${d.id}" is missing "host"`);
    return {
      id: d.id,
      host: d.host,
      port: d.port ?? 23,
      pollIntervalMs: d.pollIntervalMs ?? cfg.poll.intervalMs,
      command: cfg.command,
      reconnect: cfg.reconnect,
    };
  });
};

const applyEnv = (cfg) => ({
  ...cfg,
  logLevel: process.env.LOG_LEVEL ?? cfg.logLevel,
  mqtt: {
    ...cfg.mqtt,
    url: process.env.MQTT_URL ?? cfg.mqtt.url,
    prefix: process.env.MQTT_PREFIX ?? cfg.mqtt.prefix,
    username: process.env.MQTT_USERNAME ?? cfg.mqtt.username,
    password: process.env.MQTT_PASSWORD ?? cfg.mqtt.password,
    clientId: process.env.MQTT_CLIENT_ID ?? cfg.mqtt.clientId,
  },
});

export const loadConfig = () => {
  const path = process.env.AUDIOCONTROL_HYPERION_CONFIG ?? process.argv[2];
  const fromFile = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const merged = applyEnv(merge(DEFAULTS, fromFile));
  const devices = normalizeDevices(merged.devices, merged);
  if (devices.length === 0) throw new Error('no devices configured');
  return { ...merged, devices };
};
