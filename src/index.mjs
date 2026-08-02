#!/usr/bin/env node
// index.mjs — entrypoint. Wire config -> MQTT bus -> one device per config
// entry, and shut down cleanly on SIGINT/SIGTERM (systemd stop).

import { loadConfig } from './config.mjs';
import { createMqtt } from './mqtt.mjs';
import { createDevice } from './device.mjs';
import { makeLogger } from './log.mjs';

const main = () => {
  const cfg = loadConfig();
  const log = makeLogger(cfg.logLevel, 'hyperion');
  log.info('starting', { devices: cfg.devices.map((d) => d.id), prefix: cfg.mqtt.prefix });

  const mqttBus = createMqtt({ ...cfg.mqtt, log: log.child('mqtt') });
  const devices = cfg.devices.map((d) => createDevice(d, mqttBus, log));
  devices.forEach((d) => d.start());

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { sig });
    devices.forEach((d) => d.stop());
    mqttBus.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref(); // hard backstop
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

main();
