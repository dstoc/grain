/** Local scheduling policy. These values are not wire-format or retention limits. */
export const DEFAULT_INGEST_LIMITS = {
  messageBytes: 8 * 1024 * 1024,
  decodeOperations: 100_000,
  depth: 64,
  operations: 10_000,
  persistenceBytes: 32 * 1024 * 1024,
} as const;

/** Operational failure: raising local capacity can retry the original facts. */
export class IngestCapacityError extends Error {
  readonly retryable = true;
  constructor(
    readonly stage: 'carrier' | 'envelope' | 'native' | 'validation' | 'persistence',
    readonly limit: string,
    readonly required: number,
  ) {
    super(`${stage} requires ${limit} >= ${required}`);
    this.name = 'IngestCapacityError';
  }
}

/** Established encoding violation, never a scheduling/implementation failure. */
export class IngestDataError extends Error {
  constructor(
    readonly stage: 'carrier' | 'envelope' | 'native',
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IngestDataError';
  }
}

export type Work<T> = Generator<void, T, void>;
export type Computation<T> =
  | { readonly state: 'complete'; readonly value: T }
  | { readonly state: 'deferred'; readonly continuation: Continuation<T> };
export interface Continuation<T> {
  /** A consumed or invalidated continuation cannot publish a result. */
  resume(operations?: number): Computation<T>;
  cancel(): void;
}
export function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid local ingest limit');
}

/** Each yield charges one documented visit. No partial value is observable. */
export function compute<T>(
  work: Work<T>,
  operations = DEFAULT_INGEST_LIMITS.operations as number,
  current: () => boolean = () => true,
): Computation<T> {
  assertLimit(operations);
  if (!current()) {
    work.return(undefined as T);
    throw new Error('Ingest continuation invalidated by changed facts');
  }
  for (let index = 0; index < operations; index++) {
    const next = work.next();
    if (next.done) {
      if (!current()) throw new Error('Ingest continuation invalidated by changed facts');
      return { state: 'complete', value: next.value };
    }
  }
  let consumed = false;
  return {
    state: 'deferred',
    continuation: {
      cancel: () => {
        if (!consumed) {
          consumed = true;
          work.return(undefined as T);
        }
      },
      resume: (budget) => {
        if (consumed) throw new Error('Ingest continuation already consumed');
        consumed = true;
        return compute(work, budget, current);
      },
    },
  };
}
export function finish<T>(work: Work<T>): T {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

/** Bound an indivisible downstream decoder before entering it. Exhaustion requires capacity. */
export function* guardDecode<T>(
  work: Work<T>,
  operations: number,
  stage: 'envelope' | 'native',
): Work<T> {
  assertLimit(operations);
  try {
    for (let count = 0; count < operations; count++) {
      const next = work.next();
      if (next.done) return next.value;
      yield;
    }
    throw new IngestCapacityError(stage, 'decodeOperations', operations + 1);
  } finally {
    work.return(undefined as T);
  }
}
