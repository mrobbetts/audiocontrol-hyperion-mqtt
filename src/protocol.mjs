// protocol.mjs — PURE DATA describing the AudioControl Hyperion "ACP" ASCII protocol.
//
// This is the single source of truth for the wire protocol, recovered from the
// published ACP API and cross-checked against the decompiled Crestron driver.
// It contains no I/O — just tables and pure builder/parser fragments that
// codec.mjs turns into encode()/parse(). Keeping it declarative means adding a
// command or a model variant is a data edit, not a code change.
//
// Transport is TCP/23, ASCII, CRLF-terminated, request/response (no async push
// documented — the daemon polls). Every SET is echoed back with its GET-shaped
// response, so the same matcher both confirms a command and updates state.

// ---- token <-> normalized-value maps -------------------------------------

// Surround / decode modes. Normalized (MQTT-facing) <-> wire token.
const MODE_TABLE = [
  ['native', 'NATIVE'],
  ['2chStereo', '2CHSTEREO'],
  ['allChStereo', 'ALLCHSTEREO'],
  ['dolbySurround', 'DOLBY SURROUND'],
  ['dolbyMode', 'DOLBY MODE'],
  ['last', 'LAST'],
];
const MODE_TO_WIRE = new Map(MODE_TABLE);
const WIRE_TO_MODE = new Map(MODE_TABLE.map(([n, w]) => [w, n]));

export const normMode = (wire) => WIRE_TO_MODE.get(wire.trim().toUpperCase()) ?? wire.trim();
export const modeToken = (v) => MODE_TO_WIRE.get(v) ?? String(v).toUpperCase();

const up = (v) => String(v).trim().toUpperCase();
const lo = (v) => String(v).trim().toLowerCase();

export const asBool = (v) => v === true || ['on', 'true', '1', 'yes', 'mute'].includes(lo(v));
const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v))));

// Relative volume step: `SET VOL+ n` / `SET VOL- n` (n>=1). Sign picks direction.
const stepCmd = (base, v) => {
  const n = Math.round(Number(v));
  const mag = Math.abs(n) || 1;
  return `SET ${base}${n < 0 ? '-' : '+'} ${mag}`;
};

// ---- event helper: 'a/b' + value -> { path:['a','b'], value } -------------
const ev = (path, value) => ({ path: path.split('/'), value });

// ---- COMMANDS (encoders) --------------------------------------------------
// Each: build(arg) -> wire string (no CRLF); expect -> RegExp that the device's
// confirmation line matches (null = fire-and-forget, no correlated reply).
// Per-input commands take arg = { input, value }.
export const commands = {
  power: { build: (v) => `SET POWER ${asBool(v) ? 'ON' : 'OFF'}`, expect: /^POWER (ON|OFF)$/ },
  // NB: the device's own drivers emit `SET INPUT <x> ` with a trailing space; kept verbatim.
  input: { build: (v) => `SET INPUT ${up(v)} `, expect: /^INPUT (EARC|DIGITAL)$/ },
  audioMode: { build: (v) => `SET AUDIO MODE ${modeToken(v)}`, expect: /^AUDIO MODE / },

  'speaker/volume': { build: (v) => `SET VOL ${clampInt(v, 0, 100)}`, expect: /^(VOL \d+|VOL DEFEATED)$/ },
  'speaker/volumeStep': { build: (v) => stepCmd('VOL', v), expect: /^VOL \d+$/ },
  'speaker/mute': { build: (v) => `SET ${asBool(v) ? 'MUTE' : 'UNMUTE'}`, expect: /^(MUTE|UNMUTE)$/ },
  'speaker/maxVolume': { build: (v) => `SET MAX VOL ${clampInt(v, 10, 100)}`, expect: /^MAX VOL \d+$/ },
  'speaker/onVolume': { build: (v) => `SET ON VOL ${clampInt(v, 0, 100)}`, expect: /^ON VOL \d+$/ },

  'downmix/volume': { build: (v) => `SET DMVOL ${clampInt(v, 0, 100)}`, expect: /^(DMVOL \d+|DMVOL FOLLOW LOCKED)$/ },
  'downmix/volumeStep': { build: (v) => stepCmd('DMVOL', v), expect: /^DMVOL \d+$/ },
  'downmix/mute': { build: (v) => `SET ${asBool(v) ? 'DMMUTE' : 'DMUNMUTE'}`, expect: /^(DMMUTE|DMUNMUTE)$/ },
  'downmix/maxVolume': { build: (v) => `SET MAX DMVOL ${clampInt(v, 10, 100)}`, expect: /^MAX DMVOL \d+$/ },
  'downmix/onVolume': { build: (v) => `SET ON DMVOL ${clampInt(v, 0, 100)}`, expect: /^ON DMVOL \d+$/ },
  // Volume Type: off=Independent, on=Follow Main, defeat=fixed at 100%.
  'downmix/follow': { build: (v) => `SET DMVOL FOLLOW ${up(v)}`, expect: /^DMVOL FOLLOW (ON|OFF|DEFEAT)$/ },

  'sub/mute': { build: (v) => `SET SUB ${asBool(v) ? 'MUTE' : 'UNMUTE'}`, expect: /^SUB (MUTE|UNMUTE)$/ },

  // Per-input decode settings. arg = { input:'earc'|'digital', value }
  twoChMode: { build: ({ input, value }) => `SET 2CH MODE ${up(input)} ${modeToken(value)}`, expect: /^2CH MODE / },
  multiChMode: { build: ({ input, value }) => `SET MULTICH MODE ${up(input)} ${modeToken(value)}`, expect: /^MULTICH MODE / },
  gain: { build: ({ input, value }) => `SET INPUT GAIN ${up(input)} ${up(value)}`, expect: /^INPUT GAIN / },
  drc: { build: ({ input, value }) => `SET DRC ${up(input)} ${up(value)}`, expect: /^DRC / },

  // Escape hatch: send an arbitrary ACP line verbatim (the "Send API Command" passthrough).
  raw: { build: (v) => String(v), expect: null },
};

// ---- MATCHERS (parsers) ---------------------------------------------------
// Ordered; first match wins. Each maps a device line -> state event.
// Anchored with ^...$ so e.g. `MAX VOL 30` never matches the `VOL \d+` rule.
export const matchers = [
  { re: /^POWER (ON|OFF)$/, f: (m) => ev('power', m[1] === 'ON') },
  { re: /^INPUT (EARC|DIGITAL)$/, f: (m) => ev('input', lo(m[1])) },
  { re: /^INPUT FORMAT (.*)$/, f: (m) => ev('inputFormat', m[1].trim()) },
  { re: /^OUTPUT FORMAT (.*)$/, f: (m) => ev('outputFormat', m[1].trim()) },
  { re: /^AUDIO MODE (.+)$/, f: (m) => ev('audioMode', normMode(m[1])) },

  { re: /^VOL (\d+)$/, f: (m) => ev('speaker/volume', Number(m[1])) },
  { re: /^VOL DEFEATED$/, f: () => ev('speaker/volumeDefeated', true) },
  { re: /^(MUTE|UNMUTE)$/, f: (m) => ev('speaker/mute', m[1] === 'MUTE') },
  // Real firmware's `GET STA` dump prints `VOL MAX 100` (reversed word order
  // vs the `MAX VOL` command grammar); accept both spellings.
  { re: /^(?:MAX VOL|VOL MAX) (\d+)$/, f: (m) => ev('speaker/maxVolume', Number(m[1])) },
  // Undocumented per-channel trims reported by `GET STA` (e.g. `LEFT CH GAIN 0`).
  { re: /^([A-Z]+) CH GAIN (-?\d+)$/, f: (m) => ev(`trims/${lo(m[1])}`, Number(m[2])) },
  { re: /^ON VOL (\d+)$/, f: (m) => ev('speaker/onVolume', Number(m[1])) },

  { re: /^DMVOL (\d+)$/, f: (m) => ev('downmix/volume', Number(m[1])) },
  { re: /^(DMMUTE|DMUNMUTE)$/, f: (m) => ev('downmix/mute', m[1] === 'DMMUTE') },
  { re: /^MAX DMVOL (\d+)$/, f: (m) => ev('downmix/maxVolume', Number(m[1])) },
  { re: /^ON DMVOL (\d+)$/, f: (m) => ev('downmix/onVolume', Number(m[1])) },
  { re: /^DMVOL FOLLOW (ON|OFF|DEFEAT|LOCKED)$/, f: (m) => ev('downmix/follow', lo(m[1])) },

  { re: /^SUB (MUTE|UNMUTE)$/, f: (m) => ev('sub/mute', m[1] === 'MUTE') },

  { re: /^2CH MODE (EARC|DIGITAL) (.+)$/, f: (m) => ev(`inputs/${lo(m[1])}/twoChMode`, normMode(m[2])) },
  { re: /^MULTICH MODE (EARC|DIGITAL) (.+)$/, f: (m) => ev(`inputs/${lo(m[1])}/multiChMode`, normMode(m[2])) },
  { re: /^INPUT GAIN (EARC|DIGITAL) (LOW|MED|HIGH)$/, f: (m) => ev(`inputs/${lo(m[1])}/gain`, lo(m[2])) },
  { re: /^DRC (EARC|DIGITAL) (OFF|ON|AUTO)$/, f: (m) => ev(`inputs/${lo(m[1])}/drc`, lo(m[2])) },

  { re: /^MODEL (.+)$/, f: (m) => ev('info/model', m[1].trim()) },
  // `GET SER NUM` replies `SER NUM ...`; the `GET STA` dump says `SERIAL ...`.
  { re: /^(?:SER NUM|SERIAL) (.+)$/, f: (m) => ev('info/serial', m[1].trim()) },
  { re: /^HOSTNAME (.+)$/, f: (m) => ev('info/hostname', m[1].trim()) },
  // Version lines from `GET VER INF` (also printed as the `H` header, along
  // with a bare model line like `ACP-AXIS16`).
  { re: /^MAIN MCU (V.+)$/, f: (m) => ev('info/mcuVersion', m[1].trim()) },
  { re: /^DSP (V.+)$/, f: (m) => ev('info/dspVersion', m[1].trim()) },
  { re: /^(ACP-[A-Z0-9]+)$/, f: (m) => ev('info/model', m[1]) },
  { re: /^MAC (.+)$/, f: (m) => ev('info/mac', m[1].trim()) },
];

// ---- POLL SETS ------------------------------------------------------------
// `core` = state that changes out-of-band (poll every cycle).
// `full` = core + slow-moving per-input settings (poll on connect / occasionally).
export const polls = {
  // `GET STA` is a cheap snapshot (input, volume, max, mutes, trims, DRC in one
  // burst — verified on real Axis16 firmware) but omits power, formats, modes
  // and all downmix state, so those still need individual GETs.
  core: [
    'GET STA', 'GET POWER', 'GET INPUT FORMAT', 'GET OUTPUT FORMAT', 'GET AUDIO MODE',
    'GET DMVOL', 'GET DMMUTE',
  ],
  full: [
    'GET POWER', 'GET INPUT', 'GET INPUT FORMAT', 'GET OUTPUT FORMAT', 'GET AUDIO MODE',
    'GET VOL', 'GET MUTE', 'GET MAX VOL', 'GET ON VOL',
    'GET DMVOL', 'GET DMMUTE', 'GET MAX DMVOL', 'GET ON DMVOL', 'GET DMVOL FOLLOW',
    'GET SUB MUTE',
    'GET 2CH MODE EARC', 'GET MULTICH MODE EARC', 'GET INPUT GAIN EARC', 'GET DRC EARC',
    'GET 2CH MODE DIGITAL', 'GET MULTICH MODE DIGITAL', 'GET INPUT GAIN DIGITAL', 'GET DRC DIGITAL',
    // NB: no GET MODEL — real Axis16 firmware answers it with stale content
    // from earlier replies (observed returning the MAC line and a VER INF
    // fragment on different tries). Model comes from the H header instead;
    // versions via GET VER INF.
    'GET SER NUM', 'GET MAC', 'GET VER INF',
  ],
};

export const EOL = '\r\n';
