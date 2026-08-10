// mqtt.mjs — thin wrapper over the `mqtt` client: LWT availability, retained
// status publishes, and prefix-scoped subscribe with a small topic router.
import mqtt from 'mqtt';

// payload formatting: primitives -> stable strings the rest of your fabric expects.
export const format = (v) => {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

export const createMqtt = ({ url, username, password, clientId, prefix, log }) => {
  const bridgeStatus = `${prefix}/bridge/status`;
  const client = mqtt.connect(url, {
    clientId,
    username: username || undefined,
    password: password || undefined,
    reconnectPeriod: 2000,
    will: { topic: bridgeStatus, payload: 'offline', qos: 1, retain: true },
  });

  const routes = []; // [{ re, keys, handler }]

  client.on('connect', () => {
    log.info('mqtt connected', { url });
    client.publish(bridgeStatus, 'online', { qos: 1, retain: true });
  });
  client.on('error', (err) => log.warn('mqtt error', { err: err.message }));
  client.on('message', (topic, payload, packet) => {
    // retained delivery on a command topic = a stale ghost replayed at (re)subscribe;
    // executing it re-imposes an old command on every restart. Refuse, loudly when non-empty.
    if (packet?.retain && /\/set(\/|$)/.test(topic)) {
      if (payload.length) log.warn('ignored RETAINED ghost command', { topic, payload: payload.toString().slice(0, 40) });
      return;
    }
    const msg = payload.toString();
    for (const { re, keys, handler } of routes) {
      const m = re.exec(topic);
      if (!m) continue;
      const params = Object.fromEntries(keys.map((k, i) => [k, m[i + 1]]));
      handler(params, msg);
      return;
    }
  });

  // Register a subscription. `pattern` is an MQTT filter relative to prefix,
  // with :name capture segments, e.g. ':id/set/#'. The matching '#' tail is
  // exposed to the handler as params.rest.
  const on = (pattern, handler) => {
    const filter = `${prefix}/${pattern}`;
    const keys = [];
    const reStr = filter
      .split('/')
      .map((seg) => {
        if (seg === '#') { keys.push('rest'); return '(.+)'; }
        if (seg === '+') { keys.push('_'); return '([^/]+)'; }
        if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ re: new RegExp(`^${reStr}$`), keys, handler });
    client.subscribe(filter, { qos: 1 }, (err) => {
      if (err) log.warn('subscribe failed', { filter, err: err.message });
    });
  };

  return {
    on,
    publishStatus: (id, path, value) =>
      client.publish(`${prefix}/${id}/status/${path.join('/')}`, format(value), { qos: 1, retain: true }),
    publishConnected: (id, up) =>
      client.publish(`${prefix}/${id}/status/connected`, format(up), { qos: 1, retain: true }),
    close: (cb) => client.end(false, {}, cb),
    raw: client,
  };
};
