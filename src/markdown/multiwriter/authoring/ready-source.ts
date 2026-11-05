import type { ActionEnvelope, ActorId } from '../contracts.js';

/** Borrowed immutable readiness metadata for private native writers/readers.
 * Missing metadata or a withdrawal requires the existing full-inventory path.
 * A source must not retain an earlier ready array or preparation context.
 */
export interface ReadySource {
  readonly maxLamport: bigint;
  sequence(actor: ActorId): bigint;
  has(actionKey: string): boolean;
  /** Borrowed exact payload, for private derived readers only. */
  get(actionKey: string): ActionEnvelope | undefined;
  additions(before: ReadySource):
    | {
        readonly actions: readonly ActionEnvelope[];
        readonly nodesVisited: number;
      }
    | undefined;
}
const sources = new WeakMap<object, ReadySource>();
export function registerReadySource(actions: object, source: ReadySource): void {
  sources.set(actions, source);
}
export function readySource(actions: object): ReadySource | undefined {
  return sources.get(actions);
}
