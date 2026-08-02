// state.mjs — PURE immutable state model + reducer. No I/O.
//
// State is a plain nested object keyed by the same paths the matchers/commands
// use (e.g. ['speaker','volume']). applyEvent returns a NEW state plus the leaf
// that changed (or null), so callers publish only deltas — no full-tree diffing.

export const initialState = Object.freeze({ connected: false });

export const getIn = (obj, path) =>
  path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

export const setIn = (obj, path, value) => {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  return { ...obj, [head]: setIn(obj?.[head] ?? {}, rest, value) };
};

// applyEvent(state, event) -> { state, change: {path, value} | null }
// No-op (returns the same state, change:null) when the value is unchanged, so
// idempotent poll responses don't produce spurious MQTT publishes.
export const applyEvent = (state, event) => {
  if (!event) return { state, change: null };
  const { path, value } = event;
  if (getIn(state, path) === value) return { state, change: null };
  return { state: setIn(state, path, value), change: { path, value } };
};
