// transport.mjs — the impure shell for one device's TCP/23 link.
//
// Responsibilities (the hard parts that don't belong in Node-RED):
//   * one persistent socket with exponential-backoff reconnect
//   * CRLF line framing
//   * a SERIALIZED command queue (this is a request/response device — one
//     command in flight at a time; the next is sent only after the prior one's
//     confirmation line arrives or it times out)
//   * a poll loop issuing GETs (no async push is documented)
//   * LIVENESS: "connected" is a TCP fact, not a device fact. The unit answers every GET
//     (in standby too — measured), so lines we asked for and never got mean a firmware
//     that hung with its TCP stack up: after `silenceMs` of asking into silence the
//     socket is recycled, which is also what tells the world (online -> false)
//
// It is deliberately protocol-agnostic: it moves lines in and out. Meaning is
// applied by the caller's onLine handler (codec.parse) and the state reducer.

import net from 'node:net';
import { EOL } from './protocol.mjs';

export const createTransport = ({ host, port = 23, command, reconnect, log, onLine, onConnectedChange }) => {
  let socket = null;
  let connected = false;
  let closing = false;
  let buffer = '';
  let backoff = reconnect.minMs;
  const silenceMs = command.silenceMs ?? 15_000;
  let lastRxAt = 0; // any line (or the connect itself)
  let lastTxAt = 0;
  let watchdog = null;

  const queue = []; // [{ wire, expect, resolve, tries }]
  let inflight = null;
  let inflightTimer = null;

  const setConnected = (v) => {
    if (connected === v) return;
    connected = v;
    onConnectedChange?.(v);
  };

  const clearInflight = () => {
    if (inflightTimer) clearTimeout(inflightTimer);
    inflightTimer = null;
    inflight = null;
  };

  const sendNext = () => {
    if (inflight || !connected || queue.length === 0) return;
    inflight = queue.shift();
    inflight.tries = (inflight.tries ?? 0) + 1;
    log.debug('tx', { wire: inflight.wire, try: inflight.tries });
    socket.write(inflight.wire + EOL);
    lastTxAt = Date.now();

    // Fire-and-forget commands (no expected reply) settle on a short grace
    // window, letting any incidental output reach the parser first.
    const timeout = inflight.expect ? command.timeoutMs : 150;
    inflightTimer = setTimeout(() => onInflightTimeout(), timeout);
  };

  const onInflightTimeout = () => {
    const cur = inflight;
    inflightTimer = null;
    if (!cur) return;
    if (cur.expect && cur.tries <= command.retries) {
      log.warn('command timeout, retrying', { wire: cur.wire, try: cur.tries });
      inflight = null;
      queue.unshift(cur);
      sendNext();
      return;
    }
    if (cur.expect) log.warn('command failed (no reply)', { wire: cur.wire });
    inflight = null;
    cur.resolve(false); // fire-and-forget resolves true; expected-but-timed-out resolves false
    sendNext();
  };

  const onData = (chunk) => {
    lastRxAt = Date.now();
    buffer += chunk;
    let idx;
    // Frame on CRLF; tolerate lone LF just in case.
    while ((idx = buffer.search(/\r\n|\n/)) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1));
      if (line.trim() === '') continue;
      log.debug('rx', { line });
      onLine?.(line); // always feed the parser (solicited or not)
      if (inflight?.expect && inflight.expect.test(line.trim())) {
        const cur = inflight;
        clearInflight();
        cur.resolve(true);
        sendNext();
      }
    }
  };

  const connect = () => {
    if (closing) return;
    log.info('connecting', { host, port });
    socket = net.createConnection({ host, port });
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 10_000);

    socket.on('connect', () => {
      log.info('connected');
      backoff = reconnect.minMs;
      buffer = '';
      lastRxAt = Date.now();
      setConnected(true);
      sendNext();
      clearInterval(watchdog);
      watchdog = setInterval(() => {
        // silent only counts if we have ASKED since the last thing we heard
        if (lastTxAt <= lastRxAt || Date.now() - lastRxAt < silenceMs) return;
        log.error('device silent — asked and heard nothing; recycling the socket', { silentMs: Date.now() - lastRxAt });
        socket?.destroy();
      }, Math.max(50, Math.round(silenceMs / 3)));
      watchdog.unref?.();
    });
    socket.on('data', onData);
    socket.on('error', (err) => log.warn('socket error', { err: err.message }));
    socket.on('close', () => {
      clearInterval(watchdog);
      setConnected(false);
      clearInflight();
      // Reject anything queued so callers don't hang across a drop.
      while (queue.length) queue.shift().resolve(false);
      socket = null;
      if (closing) return;
      log.warn('disconnected, reconnecting', { inMs: backoff });
      setTimeout(connect, backoff);
      backoff = Math.min(reconnect.maxMs, Math.round(backoff * reconnect.factor));
    });
  };

  return {
    start() { closing = false; connect(); },
    stop() {
      closing = true;
      clearInterval(watchdog);
      clearInflight();
      while (queue.length) queue.shift().resolve(false);
      socket?.destroy();
      socket = null;
      setConnected(false);
    },
    isConnected: () => connected,
    isIdle: () => !inflight && queue.length === 0,
    // send(wire, expect) -> Promise<boolean> (true = confirmed / sent).
    send(wire, expect = null) {
      return new Promise((resolve) => {
        if (closing) return resolve(false);
        // Refused, not queued: a command parked across an outage would fire minutes later
        // as a ghost — and a parked command made the link look busy, so the reconnect's
        // re-sync and every poll after it were skipped while the bridge said "online".
        if (!connected) { log.warn('not connected — command dropped', { wire }); return resolve(false); }
        queue.push({ wire, expect, resolve });
        sendNext();
      });
    },
  };
};
