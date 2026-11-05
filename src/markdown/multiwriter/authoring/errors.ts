import type { ActionId } from '../contracts.js';

/** Canonical facts were retained. Refresh and retry persistence; do not repeat the operation. */
export class RetainedEditError extends Error {
  readonly appended = true;
  constructor(
    readonly action: ActionId,
    cause: unknown,
  ) {
    super('Edit was appended; recover publication before the next command', { cause });
    this.name = 'RetainedEditError';
  }
}
