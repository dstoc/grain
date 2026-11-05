import type { ActionEnvelope, ActorId } from '../contracts.js';
import { compareActions } from '../contracts.js';
import { actionKey } from '../actions/references.js';
import type { ReadySource } from '../authoring/ready-source.js';
import { PersistentMap } from './map.js';
import { finish } from '../ingest/work.js';
import type { Work } from '../ingest/work.js';

/** Exact immutable ready membership. Updating a root never links earlier wrapper
 * objects/ready arrays; readers compare shared map paths, not a delta history.
 */
export class MaterializedReadyIndex implements ReadySource {
  private actions = new PersistentMap<ActionEnvelope>();
  private actors = new PersistentMap<bigint>();
  readonly maxLamport: bigint;
  constructor(
    private readonly owner: object,
    maxLamport = 0n,
  ) {
    this.maxLamport = maxLamport;
  }
  refine(
    changes: ReadonlyMap<string, ActionEnvelope | undefined>,
    maxLamport: bigint,
  ): MaterializedReadyIndex {
    return finish(this.refineSteps(changes, maxLamport));
  }
  *refineSteps(
    changes: ReadonlyMap<string, ActionEnvelope | undefined>,
    maxLamport: bigint,
  ): Work<MaterializedReadyIndex> {
    const next = new MaterializedReadyIndex(this.owner, maxLamport);
    next.actions = this.actions.fork();
    next.actors = this.actors.fork();
    const withdrawn = new Set<ActorId>();
    let changed = maxLamport !== this.maxLamport;
    for (const [key, action] of changes) {
      yield;
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
    return changed ? next : this;
  }
  sequence(actor: ActorId): bigint {
    return this.actors.get(actor) ?? 0n;
  }
  has(key: string): boolean {
    return this.actions.has(key);
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
