import type { ReadonlyMarkdownNodeView } from './node-view.js';

/** A renderer intent that must be handled by its owning editing session. */
export interface TaskStateIntent {
  readonly node: ReadonlyMarkdownNodeView;
  readonly operation: 'cycle';
}

export const TASK_STATE_INTENT_EVENT = 'task-state-intent';
