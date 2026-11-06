/** Opt-in synchronous diagnostics. No clocks, traces or counters are retained while disabled.
 * Nested spans charge only the innermost phase. Generator resumes are measured
 * separately, so time held by a suspended continuation is never charged.
 */
export type DiagnosticPhase =
  | 'draft-query'
  | 'native-preparation'
  | 'exact-author'
  | 'coupled-replay'
  | 'visibility-normalization'
  | 'selection-address'
  | 'canonical-append'
  | 'publication'
  | 'overhead';
export type DiagnosticPurpose = 'author' | 'staging' | 'publication' | 'driver';
interface DiagnosticSpan {
  readonly phase: DiagnosticPhase;
  readonly purpose: DiagnosticPurpose;
  readonly start: number;
  readonly end: number;
}
export interface DiagnosticReport {
  readonly wallMs: number;
  readonly spans: readonly DiagnosticSpan[];
  readonly calls: Readonly<Record<string, number>>;
  readonly work: Readonly<Record<string, number>>;
  readonly resources: Readonly<Record<string, readonly string[]>>;
}
class Recorder {
  readonly spans: DiagnosticSpan[] = [];
  readonly calls: Record<string, number> = {};
  readonly work: Record<string, number> = {};
  readonly resources = new Map<string, Set<string>>();
  private phase: DiagnosticPhase = 'overhead';
  private purpose: DiagnosticPurpose = 'driver';
  private since: number;
  readonly start: number;
  constructor(readonly now: () => number) {
    this.start = this.since = now();
  }
  charge(): number {
    const end = this.now();
    if (end > this.since)
      this.spans.push({
        phase: this.phase,
        purpose: this.purpose,
        start: this.since - this.start,
        end: end - this.start,
      });
    this.since = end;
    return end;
  }
  run<T>(phase: DiagnosticPhase, purpose: DiagnosticPurpose | undefined, operation: () => T): T {
    this.charge();
    const oldPhase = this.phase,
      oldPurpose = this.purpose;
    this.phase = phase;
    this.purpose = purpose ?? oldPurpose;
    const key = `${this.purpose}/${phase}`;
    this.calls[key] = (this.calls[key] ?? 0) + 1;
    try {
      return operation();
    } finally {
      this.charge();
      this.phase = oldPhase;
      this.purpose = oldPurpose;
    }
  }
  count(name: string, amount: number): void {
    const key = `${this.purpose}/${name}`;
    this.work[key] = (this.work[key] ?? 0) + amount;
  }
  finish(): DiagnosticReport {
    return {
      wallMs: this.charge() - this.start,
      spans: this.spans,
      calls: this.calls,
      work: this.work,
      resources: Object.fromEntries([...this.resources].map(([key, value]) => [key, [...value]])),
    };
  }
}
let recorder: Recorder | undefined;
export function measure<T>(
  phase: DiagnosticPhase,
  operation: () => T,
  purpose?: DiagnosticPurpose,
): T {
  return recorder ? recorder.run(phase, purpose, operation) : operation();
}
export function countWork(name: string, amount = 1): void {
  recorder?.count(name, amount);
}
export function touchWork(kind: string, id: string): void {
  if (!recorder) return;
  let ids = recorder.resources.get(kind);
  if (!ids) recorder.resources.set(kind, (ids = new Set()));
  ids.add(id);
}
/** Install only for a bounded synchronous driver call. Nested/reentrant engine
 * operations use the same recorder. Separate captures cannot overlap.
 */
export function captureDiagnostics<T>(
  operation: () => T,
  now = () => performance.now(),
): { value: T; report: DiagnosticReport } {
  if (recorder) throw new Error('A diagnostic capture is already active');
  const active = new Recorder(now);
  recorder = active;
  try {
    const value = operation();
    return { value, report: active.finish() };
  } finally {
    recorder = undefined;
  }
}
export function measureWork<T>(
  phase: DiagnosticPhase,
  work: Generator<void, T, void>,
  purpose?: DiagnosticPurpose,
): Generator<void, T, void> {
  // Preserve the original iterator and its scheduling while diagnostics are off.
  // Start capture before creating measured work; callers can explicitly wrap an
  // existing iterator inside a capture when attributing a deferred resume.
  return recorder ? measuredWork(phase, work, purpose) : work;
}
function* measuredWork<T>(
  phase: DiagnosticPhase,
  work: Generator<void, T, void>,
  purpose?: DiagnosticPurpose,
): Generator<void, T, void> {
  let done = false;
  try {
    while (true) {
      const step = measure(phase, () => work.next(), purpose);
      if (step.done) {
        done = true;
        return step.value;
      }
      yield;
    }
  } finally {
    if (!done) measure(phase, () => work.return(undefined as T), purpose);
  }
}
