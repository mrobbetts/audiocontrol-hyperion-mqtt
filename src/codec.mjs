// codec.mjs — PURE logic over the protocol tables. No I/O, fully unit-testable.
import { commands, matchers } from './protocol.mjs';

// encode(name, arg) -> { wire, expect } | throws for an unknown command.
// `wire` has no line terminator; the transport appends EOL.
export const encode = (name, arg) => {
  const spec = commands[name];
  if (!spec) throw new Error(`unknown command: ${name}`);
  return { wire: spec.build(arg), expect: spec.expect };
};

export const isCommand = (name) => Object.hasOwn(commands, name);

// parse(line) -> event { path:[...], value } | null for an unrecognized line.
// Whitespace/echo artefacts are tolerated; empty lines are ignored.
export const parse = (line) => {
  const s = line.trim();
  if (s === '') return null;
  for (const { re, f } of matchers) {
    const m = re.exec(s);
    if (m) return f(m);
  }
  return null;
};
