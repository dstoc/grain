import { expect, test } from 'vitest';
import { captureDiagnostics, countWork, measure, measureWork } from './diagnostics.js';

test('exclusive spans reconcile through nested and reentrant phases, including exceptions', () => {
  let clock = 0;
  const failure = new Error('discarded candidate');
  const { report } = captureDiagnostics(
    () => {
      clock += 2;
      measure(
        'draft-query',
        () => {
          clock += 3;
          countWork('attempts');
          measure(
            'exact-author',
            () => {
              clock += 5;
              measure('coupled-replay', () => {
                clock += 7;
              });
              clock += 11;
            },
            'author',
          );
          try {
            measure(
              'publication',
              () => {
                clock += 13;
                throw failure;
              },
              'publication',
            );
          } catch (error) {
            expect(error).toBe(failure);
          }
          clock += 17;
        },
        'author',
      );
      clock += 19;
    },
    () => clock,
  );
  expect(report.wallMs).toBe(77);
  const totals: Record<string, number> = {};
  for (const span of report.spans)
    totals[span.phase] = (totals[span.phase] ?? 0) + span.end - span.start;
  expect(totals).toEqual({
    overhead: 21,
    'draft-query': 20,
    'exact-author': 16,
    'coupled-replay': 7,
    publication: 13,
  });
  expect(report.spans.reduce((n, s) => n + s.end - s.start, 0)).toBe(report.wallMs);
  for (let i = 1; i < report.spans.length; i++)
    expect(report.spans[i].start).toBe(report.spans[i - 1].end);
  expect(report.work['author/attempts']).toBe(1);
});

test('generator suspension, cancellation and return cleanup use the active phase only while executing', () => {
  let clock = 0,
    closed = 0;
  const { report } = captureDiagnostics(
    () => {
      const work = measureWork(
        'coupled-replay',
        (function* () {
          try {
            clock += 2;
            yield;
            clock += 3;
            return 1;
          } finally {
            clock += 5;
            closed++;
          }
        })(),
      );
      expect(work.next().done).toBe(false);
      clock += 100;
      expect(work.next()).toEqual({ done: true, value: 1 });
    },
    () => clock,
  );
  expect(closed).toBe(1);
  expect(
    report.spans
      .filter((s) => s.phase === 'coupled-replay')
      .reduce((n, s) => n + s.end - s.start, 0),
  ).toBe(10);
  expect(report.wallMs).toBe(110);
});

test('disabled diagnostics preserve behavior and a thrown capture restores the disabled state', () => {
  let calls = 0;
  expect(measure('draft-query', () => ++calls)).toBe(1);
  const failure = new Error('abort');
  expect(() =>
    captureDiagnostics(() => {
      countWork('attempt');
      throw failure;
    }),
  ).toThrow(failure);
  const { report } = captureDiagnostics(() => measure('publication', () => countWork('committed')));
  expect(report.work).toEqual({ 'driver/committed': 1 });
});

test('early generator cancellation labels cleanup and normal completion does not add a return call', () => {
  let clock = 0,
    returns = 0,
    cleanups = 0;
  const make = () => {
    const work = (function* () {
      try {
        clock += 2;
        yield;
        clock += 3;
        return 1;
      } finally {
        clock += 5;
        cleanups++;
      }
    })();
    const original = work.return.bind(work);
    work.return = (value) => {
      returns++;
      return original(value);
    };
    return measureWork('coupled-replay', work);
  };
  const { report } = captureDiagnostics(
    () => {
      const cancelled = make();
      cancelled.next();
      clock += 100;
      cancelled.return(0);
      const completed = make();
      completed.next();
      completed.next();
    },
    () => clock,
  );
  expect(returns).toBe(1);
  expect(cleanups).toBe(2);
  expect(
    report.spans
      .filter((s) => s.phase === 'coupled-replay')
      .reduce((n, s) => n + s.end - s.start, 0),
  ).toBe(17);
  expect(report.wallMs).toBe(117);
});
