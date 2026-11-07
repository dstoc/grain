/** Time public engine boundaries without changing their work or scheduling.
 * Durations can nest (for example an observer can refresh during append); report
 * each boundary separately, never add them into exclusive internal phase times.
 */
export function observePhases(document, now = () => performance.now()) {
  const totals = {},
    restore = [];
  const timed = (name, operation) => {
    const start = now();
    try {
      return operation();
    } finally {
      totals[name] += now() - start;
    }
  };
  const computation = (result) => {
    if (result.state !== 'deferred') return result;
    return {
      ...result,
      continuation: {
        cancel: () => result.continuation.cancel(),
        resume: (budget) => computation(timed('refresh', () => result.continuation.resume(budget))),
      },
    };
  };
  for (const [owner, name, label] of [
    [document.store, 'append', 'append'],
    [document.store, 'applyUpdate', 'receive'],
    [document, 'certifyLocal', 'certify'],
    [document, 'stageLocalAction', 'stage'],
    [document.publication, 'refresh', 'refresh'],
  ]) {
    totals[label] = 0;
    const original = owner[name];
    if (typeof original !== 'function') continue;
    const own = Object.getOwnPropertyDescriptor(owner, name);
    owner[name] = function (...args) {
      const result = timed(label, () => original.apply(this, args));
      return label === 'refresh' ? computation(result) : result;
    };
    restore.push(() => (own ? Object.defineProperty(owner, name, own) : delete owner[name]));
  }
  return {
    snapshot: () => ({ ...totals }),
    since: (before) =>
      Object.fromEntries(
        Object.entries(totals).map(([name, value]) => [name, value - before[name]]),
      ),
    restore: () => {
      for (const reset of restore) reset();
    },
  };
}
