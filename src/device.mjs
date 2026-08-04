// device.mjs — composes transport + pure codec/state + MQTT for one unit.
//
// Flow:
//   device line  -> codec.parse -> applyEvent -> publish delta to MQTT
//   MQTT set/... -> command router -> codec.encode -> transport.send
//
// The only mutable cell here is `state`, swapped wholesale on each event
// (never mutated in place), keeping the reducer boundary clean.

import { createTransport } from './transport.mjs';
import { parse, encode, isCommand } from './codec.mjs';
import { initialState, applyEvent } from './state.mjs';
import { polls, asBool } from './protocol.mjs';
import { createHomeostat } from './homeostat.mjs';

// Maps an MQTT `set/<suffix>` topic to a command invocation. Returns the args
// object for encode(), or null if the suffix isn't a real command.
const routeSet = (suffix, payload) => {
  // Per-input decode settings: set/inputs/<earc|digital>/<twoChMode|multiChMode|gain|drc>
  const inputMatch = /^inputs\/(earc|digital)\/(twoChMode|multiChMode|gain|drc)$/.exec(suffix);
  if (inputMatch) {
    const [, input, name] = inputMatch;
    return { name, arg: { input, value: payload } };
  }
  // Direct commands whose name == topic suffix (power, speaker/volume, ...).
  if (isCommand(suffix)) {
    const boolish = /(^|\/)(mute|power)$/.test(suffix) || suffix === 'sub/mute';
    return { name: suffix, arg: boolish ? asBool(payload) : payload };
  }
  return null;
};

export const createDevice = (cfg, mqttBus, parentLog) => {
  const id = cfg.id;
  const log = parentLog.child(id);
  let state = initialState;
  let pollTimer = null;
  let homeostat = null;

  const publishDelta = ({ path, value }) => {
    mqttBus.publishStatus(id, path, value);
    homeostat?.onChange(path, value);
  };

  const onLine = (line) => {
    const event = parse(line);
    if (!event) { log.debug('unparsed line', { line }); return; }
    const { state: next, change } = applyEvent(state, event);
    state = next;
    if (change) publishDelta(change);
  };

  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    command: cfg.command,
    reconnect: cfg.reconnect,
    log: log.child('tcp'),
    onLine,
    onConnectedChange: (up) => {
      mqttBus.publishConnected(id, up);
      homeostat?.onChange(['connected'], up);
      state = { ...state, connected: up };
      if (up) pollOnce(polls.full); // full re-sync on (re)connect
    },
  });

  // Enqueue a set of GET lines, but only when the link is idle so polls don't
  // pile up behind a backlog.
  const pollOnce = (list) => {
    if (!transport.isConnected()) return;
    if (!transport.isIdle()) { log.debug('skip poll (busy)'); return; }
    for (const q of list) transport.send(q, null);
  };

  const runCommand = (suffix, payload) => {
    const route = routeSet(suffix, payload);
    if (!route) { log.warn('unknown set topic', { suffix }); return; }
    try {
      const { wire, expect } = encode(route.name, route.arg);
      log.info('command', { suffix, wire });
      transport.send(wire, expect);
    } catch (err) {
      log.warn('command build failed', { suffix, err: err.message });
    }
  };

  return {
    id,
    start() {
      // set/<id>/<anything...> — the tail after set/ is the command suffix.
      mqttBus.on(`${id}/set/#`, (params, payload) => runCommand(params.rest, payload));
      if (cfg.homeostat) {
        homeostat = createHomeostat({
          cfg: cfg.homeostat,
          deviceId: id,
          name: cfg.name,
          nativePrefix: cfg.nativePrefix,
          onCommand: runCommand,
          log: log.child('homeostat'),
        });
      }
      transport.start();
      pollTimer = setInterval(() => pollOnce(polls.core), cfg.pollIntervalMs);
      log.info('device started', { host: cfg.host, port: cfg.port, pollIntervalMs: cfg.pollIntervalMs });
    },
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      homeostat?.close();
      homeostat = null;
      transport.stop();
    },
  };
};
