import type { ActionEnvelope, ActionId } from '../contracts.js';
import { compareBytes } from '../actions/cbor.js';
import { actionKey } from '../actions/references.js';
import { ActivityValidationError } from '../visibility/activity.js';
import type { Activity, ActiveEffect } from '../visibility/activity.js';
import { groupKey } from '../visibility/identity.js';
import type { Work } from '../ingest/work.js';
import * as persistent from './map.js';
import type { MapRoot } from './map.js';

type Frontier = MapRoot<bigint> | undefined;
interface Record {
  readonly action: ActionEnvelope;
  readonly past: Frontier;
  readonly after: Frontier;
  readonly previous?: Record;
}
interface Members {
  readonly id: ActionId;
  readonly previous?: Members;
  readonly length: number;
}
interface State {
  readonly count: number;
  readonly byId?: MapRoot<Record>;
  readonly active?: MapRoot<boolean>;
  readonly groups?: MapRoot<Members>;
  readonly controls?: MapRoot<ActionEnvelope>;
  readonly last?: Record;
}
interface Payload {
  readonly key: string;
  readonly bytes: Uint8Array;
}
interface Checkpoint {
  readonly count: number;
  readonly state: State;
}
export interface ActivityWork {
  payloadsCompared: number;
  actionsReplayed: number;
  frontierEntries: number;
  checkpointRestores: number;
  coldReplays: number;
  lastReplayFrom: number;
  lastReplayLength: number;
}
export interface PreparedActivity {
  readonly value: Activity;
  commit(): void;
}
const empty: State = { count: 0 };
function* entries<T>(root: MapRoot<T> | undefined): Generator<readonly [string, T]> {
  if (!root) return;
  yield* entries(root.left);
  yield [root.key, root.value];
  yield* entries(root.right);
}
const contains = (frontier: Frontier, id: ActionId) =>
  (persistent.get(frontier, id.actor) ?? 0n) >= id.sequence;
function requireRecord(state: State, id: ActionId): Record {
  const record = persistent.get(state.byId, actionKey(id));
  if (!record)
    throw new ActivityValidationError(`Action is outside the ready closure: ${actionKey(id)}`);
  return record;
}
function activity(state: State): Activity {
  let actions: readonly ActionEnvelope[] | undefined, effects: readonly ActiveEffect[] | undefined;
  const ordered = () => {
    const records: Record[] = [];
    for (let record = state.last; record; record = record.previous) records.push(record);
    return records.reverse();
  };
  const isActive = (id: ActionId) => {
    requireRecord(state, id);
    return persistent.get(state.active, actionKey(id))!;
  };
  const observes = (observer: ActionId, prior: ActionId) => {
    const record = requireRecord(state, observer);
    requireRecord(state, prior);
    return contains(record.past, prior);
  };
  return {
    get actions() {
      return (actions ??= structuredClone(ordered().map((record) => record.action)));
    },
    get effects() {
      return (effects ??= structuredClone(
        ordered().flatMap(({ action }) =>
          isActive(action.id)
            ? action.effects.flatMap((effect, ordinal) =>
                effect.type === 'SetGroupActive' ? [] : [{ action: action.id, ordinal, effect }],
              )
            : [],
        ),
      ));
    },
    isActive,
    observes,
    isEffectActive(ref) {
      const effect = requireRecord(state, ref.action).action.effects[ref.ordinal];
      if (!Number.isSafeInteger(ref.ordinal) || ref.ordinal < 0 || !effect)
        throw new ActivityValidationError('Unknown effect ordinal');
      return effect.type !== 'SetGroupActive' && isActive(ref.action);
    },
    concurrent(left, right) {
      requireRecord(state, left);
      requireRecord(state, right);
      return (
        actionKey(left) !== actionKey(right) && !observes(left, right) && !observes(right, left)
      );
    },
  };
}

/** Disposable activity suffix cache for an MW-01-certified, semantically ordered ready set.
 * Actor frontiers are valid because every ready actor chain includes its predecessor.
 * Layout/ownership still replay independently in the full semantic projector.
 */
export class MaterializedActivity {
  private state = empty;
  private order: readonly Payload[] = [];
  private checkpoints: readonly Checkpoint[] = [];
  private generation = 0;
  private readonly counts: ActivityWork = {
    payloadsCompared: 0,
    actionsReplayed: 0,
    frontierEntries: 0,
    checkpointRestores: 0,
    coldReplays: 0,
    lastReplayFrom: 0,
    lastReplayLength: 0,
  };
  diagnostics(): Readonly<ActivityWork & { retainedCheckpoints: number; retainedActions: number }> {
    return {
      ...this.counts,
      retainedCheckpoints: this.checkpoints.length,
      retainedActions: this.order.length,
    };
  }
  *prepare(
    actions: readonly ActionEnvelope[],
    variants: ReadonlyMap<string, Uint8Array>,
  ): Work<PreparedActivity> {
    const generation = ++this.generation;
    let frontier = Math.min(actions.length, this.order.length);
    const order: Payload[] = [];
    for (let index = 0; index < actions.length; index++) {
      yield;
      const key = actionKey(actions[index].id),
        bytes = variants.get(key);
      if (!bytes) throw new Error('Activity cache requires exact ready payloads');
      const prior = this.order[index];
      this.counts.payloadsCompared++;
      if (prior?.key === key && compareBytes(prior.bytes, bytes) === 0) order.push(prior);
      else {
        frontier = Math.min(frontier, index);
        order.push({ key, bytes: bytes.slice() });
      }
    }
    let state = empty;
    let checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.count <= frontier);
    if (frontier === this.order.length) state = this.state;
    else if (checkpoints.length) {
      state = checkpoints.at(-1)!.state;
      this.counts.checkpointRestores++;
    } else this.counts.coldReplays++;
    const from = state.count;
    for (let index = from; index < actions.length; index++) {
      state = yield* this.advance(state, actions[index]);
      this.counts.actionsReplayed++;
      if (state.count % 128 === 0) checkpoints.push({ count: state.count, state });
    }
    checkpoints = checkpoints.slice(-8);
    const value = activity(state);
    let committed = false;
    return {
      value,
      commit: () => {
        if (committed || generation !== this.generation)
          throw new Error('Activity candidate is no longer current');
        committed = true;
        this.state = state;
        this.order = order;
        this.checkpoints = checkpoints;
        this.counts.lastReplayFrom = from;
        this.counts.lastReplayLength = actions.length - from;
      },
    };
  }
  private *advance(state: State, input: ActionEnvelope): Work<State> {
    yield;
    const action = structuredClone(input),
      key = actionKey(action.id);
    if (persistent.get(state.byId, key))
      throw new ActivityValidationError(`Duplicate action in ready set: ${key}`);
    let past: Frontier;
    for (const id of action.dependencies) {
      yield;
      const dependency = requireRecord(state, id);
      if (dependency.action.lamport >= action.lamport)
        throw new ActivityValidationError('Noncausal ready dependency');
      if (!past) past = dependency.after;
      else if (past !== dependency.after)
        for (const [actor, sequence] of entries(dependency.after)) {
          yield;
          this.counts.frontierEntries++;
          if ((persistent.get(past, actor) ?? 0n) < sequence)
            past = persistent.set(past, actor, sequence);
        }
    }
    if (
      action.id.sequence === 0n ||
      (action.id.sequence > 1n &&
        !action.dependencies.some(
          (id) => id.actor === action.id.actor && id.sequence === action.id.sequence - 1n,
        ))
    )
      throw new ActivityValidationError('Activity cache requires certified actor chains');
    if (action.groupId.session.actor !== action.id.actor)
      throw new ActivityValidationError('An action must belong to its actor session');
    const record: Record = {
      action,
      past,
      after: persistent.set(past, action.id.actor, action.id.sequence),
      previous: state.last,
    };
    let active = persistent.set(state.active, key, true),
      groups = state.groups,
      controls = state.controls;
    const control = action.effects.find((effect) => effect.type === 'SetGroupActive');
    if (!control) {
      const group = groupKey(action.groupId);
      if (persistent.get(controls, group))
        throw new ActivityValidationError('A controlled group is sealed');
      const previous = persistent.get(groups, group);
      groups = persistent.set(groups, group, {
        id: action.id,
        previous,
        length: (previous?.length ?? 0) + 1,
      });
    } else {
      if (
        action.effects.length !== 1 ||
        action.allocations.length ||
        action.nativeManifest.length ||
        action.nativeInsertUpdates.length
      )
        throw new ActivityValidationError(
          'A group control cannot contain editable effects or allocations',
        );
      if (
        action.id.actor !== control.group.session.actor ||
        action.groupId.session.local !== control.group.session.local
      )
        throw new ActivityValidationError('Only the owning session can control a group');
      const group = groupKey(control.group),
        previous = persistent.get(controls, group);
      if (
        (previous ? actionKey(previous.id) : null) !==
        (control.previousControl ? actionKey(control.previousControl) : null)
      )
        throw new ActivityValidationError('Control must extend the previous owner control');
      if (previous && !contains(past, previous.id))
        throw new ActivityValidationError('Control must observe the previous owner control');
      const members = persistent.get(groups, group),
        targets = new Set(control.actions.map(actionKey));
      if (
        !targets.size ||
        targets.size !== control.actions.length ||
        targets.size !== (members?.length ?? 0)
      )
        throw new ActivityValidationError(
          'Control must target every action in one nonempty sealed group',
        );
      for (let member = members; member; member = member.previous) {
        yield;
        if (!targets.has(actionKey(member.id)))
          throw new ActivityValidationError(
            'Control must target every action in one nonempty sealed group',
          );
      }
      for (const id of control.actions) {
        yield;
        requireRecord(state, id);
        if (!contains(past, id))
          throw new ActivityValidationError('Control must observe all target actions');
        active = persistent.set(active, actionKey(id), control.active);
      }
      controls = persistent.set(controls, group, action);
    }
    return {
      count: state.count + 1,
      byId: persistent.set(state.byId, key, record),
      last: record,
      active,
      groups,
      controls,
    };
  }
  cancel(): void {
    this.generation++;
  }
  evict(): void {
    this.cancel();
    this.state = empty;
    this.order = [];
    this.checkpoints = [];
  }
}
