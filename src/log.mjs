// log.mjs — tiny leveled logger (stderr), JSON-friendly for journald.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export const makeLogger = (level = 'info', scope = '') => {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, extra) => {
    if (LEVELS[lvl] > threshold) return;
    const prefix = scope ? `[${scope}] ` : '';
    const line = `${lvl.toUpperCase()} ${prefix}${msg}`;
    // extra (if any) printed compactly on the same line for grep-ability.
    console.error(extra === undefined ? line : `${line} ${JSON.stringify(extra)}`);
  };
  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (childScope) => makeLogger(level, scope ? `${scope}:${childScope}` : childScope),
  };
};
