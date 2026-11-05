import type { ActionEnvelope, ActorId } from '../contracts.js';
import { compareActions } from '../contracts.js';
import { actionKey } from '../actions/references.js';
import type { ReadySource } from '../authoring/ready-source.js';
import { readySource, registerReadySource } from '../authoring/ready-source.js';
import { PersistentMap } from './map.js';
import { OrderedActions } from './ordered-actions.js';
import type { ReadySequence } from '../authoring/ready-source.js';
import { finish } from '../ingest/work.js';
import type { Work } from '../ingest/work.js';

/** Attach exact base membership to an unpublished one-action command sequence.
 * The wrapper owns no ready array or preparation context and is never canonical
 * readiness evidence. Its consumer still validates/reduces the staged action.
 */
export function registerReadyAppend(
  sequence: object,
  base: ReadySequence,
  action: ActionEnvelope,
): void {
  const source = readySource(base),
    key = actionKey(action.id);
  if (!source || source.has(key)) return;
  registerReadySource(sequence, {
    maxLamport: action.lamport > source.maxLamport ? action.lamport : source.maxLamport,
    has: (id) => id === key || source.has(id),
    get: (id) => (id === key ? action : source.get(id)),
    sequence: (actor) =>
      actor === action.id.actor && action.id.sequence > source.sequence(actor)
        ? action.id.sequence
        : source.sequence(actor),
    additions(before) {
      const additions = source.additions(before);
      if (!additions) return undefined;
      return {
        actions: [...additions.actions, action].sort(compareActions),
        nodesVisited: additions.nodesVisited,
      };
    },
  });
}

/** Exact immutable ready membership. Updating a root never links earlier wrapper
 * objects/ready arrays; readers compare shared map paths, not a delta history.
 */
export class MaterializedReadyIndex implements ReadySource {
  private actions = new PersistentMap<ActionEnvelope>();
  private actors = new PersistentMap<bigint>();
  private ordered = new OrderedActions();
  private maximum: bigint;
  get maxLamport(): bigint {
    return this.maximum;
  }
  constructor(
    private readonly owner: object,
    maxLamport = 0n,
  ) {
    this.maximum = maxLamport;
    registerReadySource(this, this);
  }
  refine(
    changes: ReadonlyMap<string, ActionEnvelope | undefined>,
    maxLamport?: bigint,
  ): MaterializedReadyIndex {
    return finish(this.refineSteps(changes, maxLamport));
  }
  *refineSteps(
    changes: ReadonlyMap<string, ActionEnvelope | undefined>,
    maxLamport?: bigint,
  ): Work<MaterializedReadyIndex> {
    const next = new MaterializedReadyIndex(this.owner, maxLamport);
    next.actions = this.actions.fork();
    next.actors = this.actors.fork();
    next.ordered = this.ordered;
    const withdrawn = new Set<ActorId>();
    let changed = false;
    for (const [key, action] of changes) {
      yield;
      next.ordered = next.ordered.replace(next.actions.get(key), action);
      if (action) {
        changed ||= next.actions.get(key) !== action;
        next.actions.set(key, action);
        if (action.id.sequence > next.sequence(action.id.actor))
          next.actors.set(action.id.actor, action.id.sequence);
      } else {
        const old = next.actions.get(key);
        if (old) {
          changed = true;
          next.actions.delete(key);
          withdrawn.add(old.id.actor);
        }
      }
    }
    for (const actor of withdrawn) {
      let sequence = next.sequence(actor);
      while (sequence && !next.actions.has(actionKey({ actor, sequence }))) {
        yield;
        sequence--;
      }
      next.actors.set(actor, sequence);
    }
    next.maximum = maxLamport ?? next.at(-1)?.lamport ?? 0n;
    changed ||= next.maxLamport !== this.maxLamport;
    return changed ? next : this;
  }
  get length(): number {
    return this.ordered.length;
  }
  at(index: number): ActionEnvelope | undefined {
    return this.ordered.at(index);
  }
  [Symbol.iterator](): Iterator<ActionEnvelope> {
    return this.ordered[Symbol.iterator]();
  }
  sequence(actor: ActorId): bigint {
    return this.actors.get(actor) ?? 0n;
  }
  has(key: string): boolean {
    return this.actions.has(key);
  }
  get(key: string): ActionEnvelope | undefined {
    return this.actions.get(key);
  }
  additions(before: ReadySource) {
    if (before === this) return { actions: [], nodesVisited: 0 };
    if (!(before instanceof MaterializedReadyIndex) || before.owner !== this.owner)
      return undefined;
    const actions: ActionEnvelope[] = [];
    let nodesVisited = 0;
    for (const change of this.actions.changes(before.actions, () => nodesVisited++)) {
      if (change.before || !change.after) return undefined;
      actions.push(change.after);
    }
    actions.sort(compareActions);
    return { actions, nodesVisited };
  }
}
