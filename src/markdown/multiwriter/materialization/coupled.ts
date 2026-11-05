import { OwnershipResult } from '../ownership/ownership.js';
import type { NativeView } from '../ingest/publication.js';
import type { ActionEnvelope } from '../contracts.js';
import { changedNativeTapes } from './native.js';
import type { ProjectionInput } from '../projection/project.js';
import type { Activity } from '../visibility/activity.js';
import { selectInterpretations } from '../projection/interpretation.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import type { OwnershipCheckpoint } from './ownership.js';
import { replayOwnershipSuffix } from './ownership.js';

interface Payload {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly decisions: string;
}
export interface CoupledWork {
  actionsReplayed: number;
  effectsReplayed: number;
  checkpointRestores: number;
  coldReplays: number;
  nativeMarkerFallbacks: number;
  lastReplayFrom: number;
  lastReplayLength: number;
}
/** The structural checkpoint holds placement and ownership at the same effect prefix.
 * Text-only native changes preserve cell identities. Existing-tape marker refinement
 * currently invalidates conservatively from genesis; it never reuses an unchecked prefix.
 */
export class MaterializedOwnership {
  private state?: OwnershipCheckpoint;
  private resources?: Pick<
    ReturnType<typeof replayOwnershipSuffix>,
    'homes' | 'cohorts' | 'requirements'
  >;
  private native?: NativeView;
  private order: readonly Payload[] = [];
  private checkpoints: readonly OwnershipCheckpoint[] = [];
  private markers: ReadonlyMap<string, string> = new Map();
  private generation = 0;
  private readonly counts: CoupledWork = {
    actionsReplayed: 0,
    effectsReplayed: 0,
    checkpointRestores: 0,
    coldReplays: 0,
    nativeMarkerFallbacks: 0,
    lastReplayFrom: 0,
    lastReplayLength: 0,
  };
  diagnostics() {
    return { ...this.counts, retainedCheckpoints: this.checkpoints.length };
  }
  *prepare(input: ProjectionInput, activity: Activity, variants: ReadonlyMap<string, Uint8Array>) {
    const generation = ++this.generation;
    const interpretations = selectInterpretations(activity, input.initialProperties);
    let frontier = Math.min(this.order.length, input.actions.length);
    const order: Payload[] = [];
    for (let i = 0; i < input.actions.length; i++) {
      yield;
      const action = input.actions[i].action,
        key = actionKey(action.id),
        bytes = variants.get(key);
      if (!bytes) throw new Error('Coupled replay requires exact ready payloads');
      const decisions = action.effects
        .map((_, ordinal) => {
          const ref = { action: action.id, ordinal };
          return `${Number(activity.isEffectActive(ref) && interpretations.effectEligible(ref))}${Number(interpretations.eligible(ref))}`;
        })
        .join('');
      const previous = this.order[i];
      if (
        previous?.key === key &&
        previous.decisions === decisions &&
        compareBytes(previous.bytes, bytes) === 0
      )
        order.push(previous);
      else {
        frontier = Math.min(frontier, i);
        order.push({ key, bytes, decisions });
      }
    }
    const allocations = [
      ...input.genesis.allocations,
      ...input.actions.flatMap(({ action }) => action.allocations),
    ];
    const snapshots = allocations.flatMap((a) =>
      a.type === 'tape' ? [input.native.snapshot(a.id)] : [],
    );
    const markers = new Map(
      snapshots.map((snapshot) => [
        resourceKey(snapshot.tape),
        snapshot.parts
          .flatMap((p) =>
            p.type === 'marker' ? [JSON.stringify([resourceKey(p.marker), p.native])] : [],
          )
          .join('|'),
      ]),
    );
    const nativeChanged = [...this.markers].some(
      ([key, signature]) => markers.get(key) !== signature,
    );
    if (nativeChanged) {
      frontier = 0;
      this.counts.nativeMarkerFallbacks++;
    }
    let checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.count <= frontier);
    const resume =
      !nativeChanged && frontier === this.order.length ? this.state : checkpoints.at(-1);
    if (resume && resume !== this.state) this.counts.checkpointRestores++;
    if (!resume) this.counts.coldReplays++;
    yield;
    const from = resume?.count ?? 0;
    const result = replayOwnershipSuffix(
      {
        genesis: input.genesis,
        actions: input.actions,
        snapshots,
        isActive: (order) =>
          activity.isEffectActive({ action: order.action.id, ordinal: order.ordinal }) &&
          interpretations.effectEligible({ action: order.action.id, ordinal: order.ordinal }),
        interpretationEligible: (order) =>
          interpretations.eligible({ action: order.action.id, ordinal: order.ordinal }),
      },
      activity,
      resume,
      (checkpoint) => checkpoints.push(checkpoint),
    );
    this.counts.actionsReplayed += input.actions.length - from;
    this.counts.effectsReplayed += input.actions
      .slice(from)
      .reduce((sum, { action }) => sum + action.effects.length, 0);
    checkpoints = checkpoints.slice(-8);
    let committed = false;
    return {
      value: { ownership: result.value, snapshots },
      commit: () => {
        if (committed || generation !== this.generation)
          throw new Error('Coupled candidate is no longer current');
        committed = true;
        this.state = result.state;
        this.resources = result;
        this.native = input.native;
        this.order = order;
        this.markers = markers;
        this.checkpoints = checkpoints;
        this.counts.lastReplayFrom = from;
        this.counts.lastReplayLength = input.actions.length - from;
      },
    };
  }
  prepareText(
    actions: readonly ActionEnvelope[],
    native: NativeView,
    activity: Activity,
    variants: ReadonlyMap<string, Uint8Array>,
  ) {
    const action = actions.at(-1),
      prior = this.state,
      resources = this.resources;
    if (
      !prior ||
      !resources ||
      !this.native ||
      !action ||
      actions.length !== this.order.length + 1 ||
      action.allocations.length ||
      action.effects.some((effect) => effect.type !== 'InsertText') ||
      action.nativeManifest.some((birth) => birth.type !== 'text') ||
      this.order.some(
        (payload, i) =>
          payload.key !== actionKey(actions[i].id) || variants.get(payload.key) !== payload.bytes,
      )
    )
      return undefined;
    const touched = changedNativeTapes(this.native, native);
    if (!touched) return undefined;
    const generation = ++this.generation;
    const index = prior.index.refine(touched.map((tape) => native.snapshot(tape)));
    const layout = prior.layout.fork();
    layout.beginAction({ action, births: [] }, (id) => activity.observes(action.id, id));
    for (let ordinal = 0; ordinal < action.effects.length; ordinal++)
      layout.step(ordinal, activity.isEffectActive({ action: action.id, ordinal }));
    const state: OwnershipCheckpoint = { ...prior, count: actions.length, layout, index };
    const value = new OwnershipResult(
      layout,
      index,
      prior.owners,
      prior.roots,
      prior.attachments,
      resources.cohorts,
      resources.requirements,
      resources.homes,
    );
    const decisions = action.effects
      .map((_, ordinal) => `${Number(activity.isEffectActive({ action: action.id, ordinal }))}0`)
      .join('');
    const payload: Payload = {
      key: actionKey(action.id),
      bytes: variants.get(actionKey(action.id))!,
      decisions,
    };
    let committed = false;
    this.counts.actionsReplayed++;
    this.counts.effectsReplayed += action.effects.length;
    return {
      value,
      touched,
      commit: () => {
        if (committed || generation !== this.generation)
          throw new Error('Coupled text candidate is no longer current');
        committed = true;
        this.state = state;
        this.native = native;
        this.order = [...this.order, payload];
        if (state.count % 128 === 0) this.checkpoints = [...this.checkpoints, state].slice(-8);
        this.counts.lastReplayFrom = actions.length - 1;
        this.counts.lastReplayLength = 1;
      },
    };
  }
  cancel(): void {
    this.generation++;
  }
  evict(): void {
    this.cancel();
    this.state = undefined;
    this.resources = undefined;
    this.native = undefined;
    this.order = [];
    this.checkpoints = [];
    this.markers = new Map();
  }
}
