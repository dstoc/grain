import { countWork, measureWork, touchWork } from '../diagnostics.js';
import { measure } from '../diagnostics.js';
import { readySource } from '../authoring/ready-source.js';
import type { ReadySequence, ReadySource } from '../authoring/ready-source.js';
import { actionKey } from '../actions/references.js';
import type {
  ActionEnvelope,
  Allocation,
  NodeId,
  RunId,
  RangeRef,
  NativeTextRange,
  TapeId,
} from '../contracts.js';
import type { NativeView } from '../ingest/publication.js';
import type { ActionSequence, PayloadIndex } from './activity.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import type { TextVisibility } from '../visibility/visibility.js';
import type { ProjectionInput } from '../projection/project.js';
import { projectWithActivity } from '../projection/project.js';
import type { TextBoundary, TextFragment, ViewNode } from '../projection/types.js';
import { textOrigin } from '../projection/types.js';
import { registerAddressIndex } from '../projection/addresses.js';
import { resourceKey } from '../layout/index.js';
import type { OwnershipResult } from '../ownership/ownership.js';
import { reconstructProvenance } from '../reference/provenance.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { registerCommandViewIndex } from '../authoring/view-index.js';
import { IndexedCommandView } from './view-index.js';
import { PersistentMap } from './map.js';
import { MaterializedOwnership } from './coupled.js';
import { isTextRefinement } from '../ownership/text-validation.js';
import { selectInterpretations } from '../projection/interpretation.js';
import type { PresentedProperties } from '../projection/interpretation.js';
import { isPropertyRefinement } from './properties.js';
import { finish } from '../ingest/work.js';
import { ExactTextDeletions } from './text-deletions.js';
import type { TextDeletionWork } from './text-deletions.js';
import { reduceVisibilityWithTextTags } from '../visibility/visibility.js';
import type { reduceVisibility } from '../visibility/visibility.js';
import type { StructuralProjectionChange } from './projection-changes.js';
import { ExactSyntaxMasks, withIndexedMasks } from './masks.js';

type Projection = ReturnType<typeof projectWithActivity>;
/** Seed once, then update only exact changed contributions. Until B supplies a
 * complete semantic delta, interpretation replacement/withdrawal remains a named
 * cold-index condition. The full reducer still owns subtree semantics.
 */
function indexedVisibility(
  before: State | undefined,
  actions: Iterable<ActionEnvelope>,
  source: ReadySource | undefined,
  work: TextDeletionWork,
) {
  let index: ExactTextDeletions | undefined;
  const reduce: typeof reduceVisibility = (activity, layout, tokens, birthEnabled = () => true) => {
    if (!index) {
      const additions = source && before?.source && source.additions(before.source);
      let changes =
        additions && !additions.actions.some((a) => a.effects.some((e) => e.type === 'Interpret'))
          ? new Map(additions.actions.map((a) => [actionKey(a.id), a]))
          : undefined;
      if (changes) {
        for (const action of additions!.actions)
          for (const effect of action.effects)
            if (changes && effect.type === 'SetGroupActive')
              for (const id of effect.actions) {
                const target = source!.get(actionKey(id));
                if (!target) throw new Error('Control target is outside exact projection source');
                if (target.effects.some((e) => e.type === 'Interpret')) {
                  changes = undefined;
                  break;
                }
                changes!.set(actionKey(id), target);
              }
      }
      index =
        changes && before
          ? before.deletions.update(changes.values(), activity.isEffectActive, work)
          : ExactTextDeletions.create(actions, activity.isEffectActive, work);
    }
    const order = new Map(
      activity.effects.map((ref, i) => [`${actionKey(ref.action)}:${ref.ordinal}`, i]),
    );
    return reduceVisibilityWithTextTags(activity, layout, tokens, birthEnabled, (token) =>
      index!.matches(token, work, order),
    );
  };
  return {
    reduce,
    root: () => {
      if (!index) throw new Error('Projection did not reduce visibility');
      return index;
    },
  };
}
interface NodeRecord {
  readonly node: ViewNode;
  readonly parent?: string;
  readonly depth: number;
}
interface TextTape {
  readonly entries: readonly TextVisibility[];
  readonly byId: ReadonlyMap<string, TextVisibility>;
}
interface State {
  readonly value: Projection;
  readonly nodes: PersistentMap<NodeRecord>;
  readonly text: PersistentMap<TextTape>;
  readonly deletions: ExactTextDeletions;
  readonly source?: ReadySource;
  readonly unsafeTextTapes: ReadonlySet<string>;
  readonly nodeVisibility: PersistentMap<Projection['visibility']['nodes'][number]>;
  readonly nodeAllocations: PersistentMap<Extract<Allocation, { type: 'node' }>>;
  readonly flowHomes: PersistentMap<NodeId>;
  readonly tapeNodes: PersistentMap<readonly string[]>;
  readonly tapes: PersistentMap<TapeId>;
  readonly tapeHomes: PersistentMap<RangeRef>;
  readonly rootOutputs: PersistentMap<readonly string[]>;
  readonly nodeRequirements: PersistentMap<readonly EffectRef[]>;
  readonly masks: ExactSyntaxMasks;
  readonly membership: PersistentMap<string>;
  readonly inlineCount: number;
  readonly commandIndex: IndexedCommandView;
  readonly propertyBase: Projection['interpretations'];
  readonly properties: PersistentMap<PresentedProperties>;
}
const key = (node: ViewNode) => resourceKey(node.origin.representative);
const tokenKey = (range: { readonly client: number; readonly clock: number }) =>
  `${range.client}:${range.clock}`;
/** Escaping lazy readers own only current roots. Defining these inside append
 * would also retain that edit's lexical context and its previous State. */
function projectedActivity(
  groupActivity: Activity,
  interpretations: Projection['interpretations'],
): Projection['activity'] {
  const effectActive = (ref: Parameters<Activity['isEffectActive']>[0]) =>
    groupActivity.isEffectActive(ref) && interpretations.effectEligible(ref);
  return {
    get actions() {
      return groupActivity.actions;
    },
    get effects() {
      return groupActivity.effects.filter(effectActive);
    },
    isActive: groupActivity.isActive,
    observes: groupActivity.observes,
    concurrent: groupActivity.concurrent,
    isEffectActive: effectActive,
  };
}
/** The fallback is the last full selection, never the previous overlay facade.
 * Keeping these readers outside append avoids retaining earlier publications.
 */
function propertyOverlay(
  base: Projection['interpretations'],
  properties: State['properties'],
): Projection['interpretations'] {
  return {
    ...base,
    properties: (node) => ({ ...(properties.get(resourceKey(node)) ?? base.properties(node)) }),
  };
}
function textVisibility(
  tapes: State['tapes'],
  text: State['text'],
  nodes: Projection['visibility']['nodes'],
): Projection['visibility'] {
  let allText: readonly TextVisibility[] | undefined;
  return {
    get text() {
      if (!allText) {
        countWork('projection.visibilityTapesExported', tapes.size);
        allText = [...tapes.values()].flatMap((tape) => text.get(resourceKey(tape))?.entries ?? []);
      }
      return allText;
    },
    nodes,
  };
}
/** Publication getters own current roots only, never a preparation context. */
function resourceVisibility(
  tapes: State['tapes'],
  text: State['text'],
  nodes: State['nodeVisibility'],
): Projection['visibility'] {
  const textView = textVisibility(tapes, text, []);
  let allNodes: Projection['visibility']['nodes'] | undefined;
  return {
    get nodes() {
      if (!allNodes) {
        countWork('projection.visibilityNodesExported', nodes.size);
        allNodes = [...nodes.values()];
      }
      return allNodes;
    },
    get text() {
      return textView.text;
    },
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function index(
  value: Projection,
  input: ProjectionInput,
  deletions: ExactTextDeletions,
  source?: ReadySource,
): State {
  return measure('visibility-normalization', () => indexMeasured(value, input, deletions, source));
}
function indexMeasured(
  value: Projection,
  input: ProjectionInput,
  deletions: ExactTextDeletions,
  source?: ReadySource,
): State {
  const masks = ExactSyntaxMasks.create(value.interpretations.packets);
  value = { ...value, interpretations: withIndexedMasks(value.interpretations, masks) };
  const nodes = new PersistentMap<NodeRecord>(),
    text = new PersistentMap<TextTape>(),
    tapeNodes = new PersistentMap<readonly string[]>(),
    membership = new PersistentMap<string>();
  let inlineCount = 0;
  countWork('projection.fullIndexesConstructed');
  const visit = (node: ViewNode, depth: number, parent?: string) => {
    countWork('projection.viewRecordsIndexed');
    nodes.set(key(node), { node, depth, parent });
    for (const id of node.origin.constituents) membership.set(resourceKey(id), key(node));
    if (['paragraph', 'section', 'code-block'].includes(node.type)) inlineCount++;
    // Ghost traversal slots still contribute addresses after their cells transfer.
    // Index projected readers, not just final cell owners or private-home blocks.
    const tapes = new Set([
      ...node.boundaries.map((boundary) => resourceKey(boundary.address.origin.tape)),
      ...node.fragments.map((fragment) => resourceKey(fragment.address.origin.tape)),
    ]);
    for (const tape of tapes) tapeNodes.set(tape, [...(tapeNodes.get(tape) ?? []), key(node)]);
    for (const child of node.children) visit(child, depth + 1, key(node));
  };
  visit(value.view.root, 0);
  const entries = new Map<string, TextVisibility[]>();
  for (const entry of value.visibility.text) {
    countWork('projection.visibilityEntriesIndexed');
    const id = resourceKey(entry.token.tape),
      list = entries.get(id) ?? [];
    list.push(entry);
    entries.set(id, list);
  }
  for (const [id, list] of entries)
    text.set(id, {
      entries: list,
      byId: new Map(list.map((entry) => [tokenKey(entry.token.native), entry])),
    });
  const unsafeTextTapes = new Set<string>(),
    nodeVisibility = new PersistentMap<Projection['visibility']['nodes'][number]>();
  for (const entry of value.visibility.nodes) nodeVisibility.set(resourceKey(entry.node), entry);
  // Captured subtree intervals can hide later insertions even when the tape is
  // currently empty. Mark those resources, not the entire document.
  for (const { effect } of value.activity.effects)
    if (effect.type === 'DeleteSubtree')
      for (const range of effect.scope.ownedIntervals) unsafeTextTapes.add(resourceKey(range.tape));
  // Inherited coverage follows birth content, including transferred content.
  // A conservative resource-local gate also covers explicitly captured nodes.
  for (const entry of input.birthContent)
    if (nodeVisibility.get(resourceKey(entry.node))!.tags.length)
      for (const range of entry.intervals) unsafeTextTapes.add(resourceKey(range.tape));
  const nodeAllocations = new PersistentMap<Extract<Allocation, { type: 'node' }>>(),
    flowHomes = new PersistentMap<NodeId>();
  for (const allocation of value.ownership.nodeAllocations) {
    nodeAllocations.set(resourceKey(allocation.id), allocation);
    if (allocation.flow && !flowHomes.has(resourceKey(allocation.flow)))
      flowHomes.set(resourceKey(allocation.flow), allocation.id);
    countWork('address.resourcesIndexed');
  }
  registerAddressIndex(value.ownership, value.visibility, {
    allocations: nodeAllocations,
    visibility: nodeVisibility,
    flowHomes,
  });
  const nodeRequirements = new PersistentMap<readonly EffectRef[]>();
  for (const allocation of nodeAllocations.values())
    nodeRequirements.set(resourceKey(allocation.id), []);
  for (const { nodes: destinations, order } of value.ownership.destinationRequirements)
    for (const id of new Set(destinations.map(resourceKey)))
      nodeRequirements.set(id, [
        ...(nodeRequirements.get(id) ?? []),
        { action: order.action.id, ordinal: order.ordinal },
      ]);
  const tapeHomes = new PersistentMap<RangeRef>();
  for (const allocation of [
    ...input.genesis.allocations,
    ...input.actions.flatMap(({ action }) => action.allocations),
  ])
    if (allocation.type === 'tape')
      tapeHomes.set(resourceKey(allocation.id), {
        tape: allocation.id,
        start: allocation.start,
        end: allocation.end,
      });
  const rootOutputs = new PersistentMap<readonly string[]>();
  const outputGroups = (parent: ViewNode) => {
    const containers = new Set(parent.origin.constituents.map(resourceKey));
    for (const child of parent.children) {
      const tops = new Set<string>();
      for (const origin of child.origin.constituents) {
        let node = origin,
          placement = value.ownership.blockPlacement(node);
        while (placement && !containers.has(resourceKey(placement.slot.parent))) {
          node = placement.slot.parent;
          placement = value.ownership.blockPlacement(node);
        }
        if (placement) tops.add(resourceKey(node));
      }
      for (const top of tops) rootOutputs.set(top, [...(rootOutputs.get(top) ?? []), key(child)]);
      outputGroups(child);
    }
  };
  outputGroups(value.view.root);
  const commandIndex = IndexedCommandView.create(value.view.root);
  registerCommandViewIndex(value.view.root, commandIndex);
  return {
    value,
    nodes,
    text,
    deletions,
    source,
    unsafeTextTapes,
    nodeVisibility,
    nodeAllocations,
    flowHomes,
    tapeNodes,
    commandIndex,
    tapeHomes,
    rootOutputs,
    nodeRequirements,
    masks,
    membership,
    inlineCount,
    propertyBase: value.interpretations,
    properties: new PersistentMap<PresentedProperties>(),
    tapes: (() => {
      const tapes = new PersistentMap<TapeId>();
      for (const home of tapeHomes.values()) tapes.set(resourceKey(home.tape), home.tape);
      return tapes;
    })(),
  };
}
/** Rebuild one flow's text projection while keeping its semantic children and origin.
 * Placement, visibility and interpretation decisions are fixed by the narrow append gate.
 */
function addressKey(address: ReturnType<typeof textOrigin>): string {
  const { slot, origin } = address;
  return [
    resourceKey(slot.run),
    resourceKey(slot.boundary),
    slot.side,
    slot.predecessor ? resourceKey(slot.predecessor) : '',
    resourceKey(origin.tape),
    resourceKey(origin.start),
    resourceKey(origin.end),
  ].join('|');
}
function projectInline(
  before: ViewNode,
  ownership: OwnershipResult,
  native: NativeView,
  interpretations: Projection['interpretations'],
  visible: (range: NativeTextRange) => boolean,
  homes: State['tapeHomes'],
  rootRunOverride?: RunId,
): ViewNode {
  const allocation = before.origin.representative;
  // A rendered inline is the home of the effective top-level flow. Its boundary
  // records supply the persistent run; no complete allocation/run scan is needed.
  const rootRun = rootRunOverride ?? before.boundaries[0]?.address.slot.run;
  if (!rootRun) throw new Error('Inline projection lacks an addressable root');
  const rootLayout = ownership.runLayout(rootRun),
    runs = new Map([[resourceKey(rootRun), rootLayout]]);
  const runLayout = (run: typeof rootRun) => {
    const key = resourceKey(run);
    let layout = runs.get(key);
    if (!layout) {
      layout = ownership.runLayout(run);
      runs.set(key, layout);
    }
    return layout;
  };
  const flow = rootLayout.flow;
  if (resourceKey(ownership.flowBlock(flow)) !== resourceKey(allocation))
    throw new Error('Inline owner changed during text append');
  let content = '';
  const boundaries: TextBoundary[] = [],
    fragments: TextFragment[] = [];
  const tapeEnds = new Map<string, number>();
  const addresses = new Map(before.boundaries.map((b) => [addressKey(b.address), b.address]));
  const retainedFragments = new Map<string, TextFragment>(),
    seen = new WeakSet<object>();
  for (const fragment of before.fragments) {
    if (!seen.has(fragment.address)) {
      addresses.set(addressKey(fragment.address), fragment.address);
      seen.add(fragment.address);
    }
    retainedFragments.set(tokenKey(fragment.range), fragment);
  }
  const address = (value: ReturnType<typeof textOrigin>) =>
    addresses.get(addressKey(value)) ?? freeze(value);
  for (const entry of ownership.raw(flow)) {
    if (entry.type === 'slot') {
      const marker = native.marker(entry.slot.boundary),
        id = resourceKey(marker.tape);
      let end = tapeEnds.get(id);
      if (end === undefined) {
        const home = homes.get(resourceKey(marker.tape));
        if (!home) throw new Error('Text slot lacks a retained private home');
        end = native.marker(home.end).index;
        tapeEnds.set(id, end);
      }
      if (
        (marker.index === 0 && entry.slot.side === 'left') ||
        (marker.index === end && entry.slot.side === 'right')
      )
        continue;
      const origin = runLayout(entry.slot.run).skeleton.find((range) =>
        ownership.containsBoundary(range, entry.slot.boundary),
      );
      if (!origin) throw new Error('Text slot lacks a retained origin');
      boundaries.push(
        Object.freeze({ offset: content.length, address: address(textOrigin(entry.slot, origin)) }),
      );
    } else if (entry.type === 'cell') {
      const origin = entry.assignment.cell;
      const location = address(
        textOrigin(
          {
            run: entry.assignment.run,
            boundary: origin.start,
            side: 'right',
            predecessor: null,
          },
          origin,
        ),
      );
      for (const fragment of entry.fragments) {
        let start = 0;
        while (start < fragment.text.length) {
          const masked = (i: number) =>
            interpretations.masked({
              ...fragment.range,
              clock: fragment.range.clock + i,
              length: 1,
            });
          const isVisible = (i: number) =>
            visible({ ...fragment.range, clock: fragment.range.clock + i, length: 1 });
          const mask = masked(start),
            shown = isVisible(start);
          let end = start + 1;
          while (end < fragment.text.length && masked(end) === mask && isVisible(end) === shown)
            end++;
          const range: NativeTextRange = {
            ...fragment.range,
            clock: fragment.range.clock + start,
            length: end - start,
          };
          // Raw fragments already come from the exact immutable native view.
          // Rereading each retained substring repeats native lookup and copying.
          const text = fragment.text.slice(start, end),
            prior = retainedFragments.get(tokenKey(range));
          fragments.push(
            prior &&
              prior.range.length === range.length &&
              prior.text === text &&
              prior.address === location &&
              prior.visible === (shown && !mask) &&
              prior.masked === mask
              ? prior
              : freeze({ text, range, address: location, visible: shown && !mask, masked: mask }),
          );
          if (shown && !mask) content += text;
          start = end;
        }
      }
    }
  }
  return Object.freeze({
    ...before,
    content,
    boundaries: Object.freeze(boundaries),
    fragments: Object.freeze(fragments),
  });
}

function replaceViewPaths(nodes: State['nodes'], changed: Map<string, ViewNode>): number {
  let replaced = 0;
  const pending = new Set(changed.keys());
  while (pending.size) {
    const id = [...pending].sort((a, b) => nodes.get(b)!.depth - nodes.get(a)!.depth)[0];
    pending.delete(id);
    const record = nodes.get(id)!,
      value = changed.get(id)!;
    nodes.set(id, { ...record, node: value });
    replaced++;
    if (record.parent) {
      const parent = changed.get(record.parent) ?? nodes.get(record.parent)!.node;
      changed.set(
        record.parent,
        Object.freeze({
          ...parent,
          children: Object.freeze(
            parent.children.map((child) => (key(child) === id ? value : child)),
          ),
        }),
      );
      pending.add(record.parent);
    }
  }
  countWork('projection.ancestorRecordsReplaced', replaced);
  return replaced;
}
function replaceViews(before: State, changed: Map<string, ViewNode>) {
  const nodes = before.nodes.fork(),
    replaced = replaceViewPaths(nodes, changed);
  const root = nodes.get(key(before.value.view.root))!.node;
  const commandIndex = before.commandIndex.replaceRecords(changed.values());
  registerCommandViewIndex(root, commandIndex);
  return { nodes, commandIndex, replaced };
}

/** Resource-local text and checked/info projections. Structural changes still
 * require the guarded producer; unrelated visibility features do not block edits.
 */
export class MaterializedProjection {
  private readonly ownership = new MaterializedOwnership();
  private state?: State;
  private generation = 0;
  private readonly counts = {
    fullProjections: 0,
    localStructuralProjections: 0,
    localTextProjections: 0,
    projectionRecordsReplaced: 0,
    textTapesRebuilt: 0,
    stagedTextProjections: 0,
    localTextControls: 0,
    stagedStructuralProjections: 0,
    stagedStructureActionsReplayed: 0,
    stagedStructureTapesRead: 0,
    localPropertyProjections: 0,
    stagedPropertyProjections: 0,
    exactDeletionRangesIndexed: 0,
    exactDeletionQueries: 0,
    exactDeletionNodesVisited: 0,
  };
  fullProjectionCount(): number {
    return this.counts.fullProjections;
  }
  diagnostics() {
    return { ...this.counts, ownership: this.ownership.diagnostics() };
  }
  commandOwnership() {
    return this.ownership.fork();
  }
  *prepare(
    genesis: ReferenceGenesis,
    actions: ReadySequence,
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
  ) {
    const generation = ++this.generation,
      before = this.state;
    let suffix = before
      ? this.ownership.prepareText(actions, native, activity, variants)
      : undefined;
    if (suffix && before && !this.localText(before, suffix.changes)) {
      this.ownership.cancel();
      suffix = undefined;
    }
    const properties =
      !suffix && before
        ? this.ownership.prepareProperties(actions, native, activity, variants)
        : undefined;
    const propertyState =
      properties && before
        ? this.appendProperties(
            before,
            properties.changes,
            properties.value,
            activity,
            genesis.initialProperties,
            properties.control,
          )
        : undefined;
    let state: State, commitStructure: () => void;
    if (propertyState && properties) {
      yield;
      state = propertyState;
      commitStructure = properties.commit;
      this.counts.localPropertyProjections++;
    } else if (suffix && before) {
      yield;
      state = this.append(
        before,
        actions.at(-1)!,
        suffix.value,
        suffix.touched,
        native,
        activity,
        suffix.changes,
        suffix.control,
      );
      if (suffix.control) this.counts.localTextControls++;
      commitStructure = suffix.commit;
      this.counts.localTextProjections++;
    } else {
      const input: ProjectionInput = {
        genesis: genesis.layout,
        genesisManifest: genesis.body.nativeManifest,
        initialProperties: genesis.initialProperties,
        ...reconstructProvenance(genesis.layout, [...actions]),
        native,
      };
      const prepared = yield* measureWork(
        'coupled-replay',
        this.ownership.prepare(input, activity, variants, undefined, actions),
      );
      yield;
      const visibility = indexedVisibility(before, actions, readySource(actions), this.counts);
      const value = projectWithActivity(input, activity, {
        ...prepared.value,
        visibility: visibility.reduce,
      });
      state = index(value, input, visibility.root(), readySource(actions));
      commitStructure = prepared.commit;
      this.counts.fullProjections++;
    }
    state = { ...state, source: readySource(actions) };
    let committed = false;
    return {
      value: state.value,
      commit: () => {
        if (committed || generation !== this.generation)
          throw new Error('Projection candidate is no longer current');
        commitStructure();
        committed = true;
        this.state = state;
      },
    };
  }
  /** Prepare C roots from an exact producer delta. No structural decisions are
   * replayed here. Closed paragraph gaps retain their real normalized container
   * and wrapper context. Other regions return a named reconstruction condition.
   */
  prepareStructural(change: StructuralProjectionChange) {
    return measure('visibility-normalization', () => this.prepareStructuralMeasured(change));
  }
  private prepareStructuralMeasured(change: StructuralProjectionChange) {
    const generation = ++this.generation,
      before = this.state;
    const fallback = (reason: string) => {
      countWork(`projection.fallback.${reason}`);
      for (const node of [...change.nodes, ...change.containers])
        touchWork('projection.fallbackNodes', resourceKey(node));
      for (const tape of change.tapes) touchWork('projection.fallbackTapes', resourceKey(tape));
      return {
        state: 'fallback' as const,
        reason,
        family: change.family,
        replay: change.replay,
        nodes: change.nodes,
        tapes: change.tapes,
      };
    };
    if (!before || before.value !== change.base) return fallback('incompatible-base');
    const source = readySource(change.actions),
      additions = source && before.source && source.additions(before.source);
    if (
      !additions ||
      additions.actions.length !== 1 ||
      additions.actions[0] !== change.action ||
      change.actions.at(-1) !== change.action
    )
      return fallback('missing-exact-suffix');
    for (const action of change.semanticChanges)
      for (const effect of action.effects) {
        if (effect.type === 'SetProperties') {
          const properties = before.value.interpretations.properties(effect.node);
          if (
            Object.entries(effect.values).every(
              ([name, value]) => properties[name as keyof PresentedProperties] === value,
            )
          )
            continue;
        }
        if (effect.type === 'LiftChildren' && !effect.placements.length) continue;
        if (
          effect.type === 'MoveBlock' &&
          change.structure.value.nodeAllocation(effect.node).role !== 'inline'
        )
          return fallback('wrapper-placement');
        if (effect.type === 'JoinFlow' && effect.liftedChildren.length)
          return fallback('child-lifting');
        if (
          !['InsertText', 'DeleteText', 'SplitFlow', 'JoinFlow', 'MoveBlock'].includes(effect.type)
        )
          return fallback(`semantic-${effect.type}`);
      }
    for (const tape of change.tapes)
      if (before.unsafeTextTapes.has(resourceKey(tape))) return fallback('subtree-coverage');
    const ownership = change.structure.value,
      native = change.native,
      root = before.value.view.root,
      rootKey = key(root);
    const nodeAllocations = before.nodeAllocations.fork(),
      flowHomes = before.flowHomes.fork(),
      tapeHomes = before.tapeHomes.fork(),
      nodeRequirements = before.nodeRequirements.fork();
    const tapes = before.tapes.fork();
    for (const allocation of change.action.allocations) {
      if (allocation.type === 'node') {
        nodeAllocations.set(resourceKey(allocation.id), allocation);
        if (allocation.flow && !flowHomes.has(resourceKey(allocation.flow)))
          flowHomes.set(resourceKey(allocation.flow), allocation.id);
      } else if (allocation.type === 'tape') {
        tapeHomes.set(resourceKey(allocation.id), {
          tape: allocation.id,
          start: allocation.start,
          end: allocation.end,
        });
        tapes.set(resourceKey(allocation.id), allocation.id);
      }
      countWork('projection.changedAllocationsIndexed');
    }
    const affected = new Set(change.nodes.map(resourceKey));
    affected.delete(rootKey);
    for (const tape of change.tapes)
      for (const id of before.tapeNodes.get(resourceKey(tape)) ?? []) affected.add(id);
    const context = { ...before, tapeHomes };
    const updated = this.updateText(
      context,
      change.action,
      ownership,
      change.nativeTapes,
      native,
      change.activity,
      change.semanticChanges,
      change.action.effects[0]?.type === 'SetGroupActive',
    );
    for (const id of updated.affected) affected.add(id);
    const nodes = before.nodes.fork(),
      nodeVisibility = before.nodeVisibility.fork(),
      rootOutputs = before.rootOutputs.fork(),
      tapeNodes = before.tapeNodes.fork(),
      membership = before.membership.fork();
    const changedParents = new Map<string, ViewNode>();
    for (const container of change.containers) {
      const id = before.membership.get(resourceKey(container)),
        parent = id && before.nodes.get(id);
      if (!parent) return fallback('unrepresented-container');
      changedParents.set(id!, parent.node);
    }
    for (const [id, requirements] of change.requirements) nodeRequirements.set(id, requirements);
    let inlineCount = before.inlineCount;
    const parentFor = (raw: NodeId) => before.membership.get(resourceKey(raw));
    const visible = (range: NativeTextRange) =>
      updated.text.get(resourceKey(range.tape))?.byId.get(tokenKey(range))?.visible === true;
    const interpretations = before.value.interpretations;
    const readerTapes = (node: ViewNode) =>
      new Set([
        ...node.boundaries.map((b) => resourceKey(b.address.origin.tape)),
        ...node.fragments.map((f) => resourceKey(f.range.tape)),
      ]);
    for (const id of affected) {
      const allocation = nodeAllocations.get(id),
        prior = before.nodes.get(id)?.node,
        oldVisibility = before.nodeVisibility.get(id);
      if (!allocation) return fallback('unknown-resource');
      if (!allocation.flow || allocation.role !== 'inline') {
        const parentId = parentFor(allocation.id),
          record = parentId && before.nodes.get(parentId);
        if (!record) return fallback('unrepresented-container');
        changedParents.set(parentId!, record.node);
        continue;
      }
      if (oldVisibility?.deleted || oldVisibility?.tags.length)
        return fallback('node-deletion-coverage');
      const placement = ownership.blockPlacement(allocation.id);
      const oldPlacement = before.nodeAllocations.has(id)
        ? before.value.ownership.blockPlacement(allocation.id)
        : undefined;
      const parentId = placement && parentFor(placement.slot.parent),
        oldParentId = oldPlacement && parentFor(oldPlacement.slot.parent);
      const parent = parentId && before.nodes.get(parentId);
      if (
        !parent ||
        (oldPlacement && (!oldParentId || oldParentId !== before.nodes.get(id)?.parent) && prior)
      )
        return fallback('section-range');
      if (!['document', 'section', 'block-quote', 'list-item'].includes(parent.node.type))
        return fallback('container-kind');
      const parentVisibility = before.nodeVisibility.get(resourceKey(placement!.slot.parent));
      if (!parentVisibility?.available || parentVisibility.deleted || parentVisibility.tags.length)
        return fallback('parent-visibility');
      if (
        !before.nodeAllocations.has(id) &&
        allocation.birthSlot &&
        parentFor(allocation.birthSlot.parent) !== parentId
      )
        return fallback('birth-coverage-region');
      if (oldParentId && oldParentId !== parentId) {
        const oldParent = before.nodes.get(oldParentId);
        if (!oldParent) return fallback('former-normalization-parent');
        changedParents.set(oldParentId, oldParent.node);
      }
      changedParents.set(parentId!, parent.node);
      if (
        ownership.children(allocation.id).length ||
        (oldPlacement && before.value.ownership.children(allocation.id).length)
      )
        return fallback('child-lifting');
      if (
        prior &&
        (prior.type !== 'paragraph' ||
          prior.children.length ||
          prior.origin.constituents.length !== 1 ||
          before.nodes.get(id)?.parent !== oldParentId)
      )
        return fallback('normalization-region');
      const group = before.rootOutputs.get(id);
      if (group?.length && (group.length !== 1 || group[0] !== id))
        return fallback('normalized-constituents');
      const properties = interpretations.properties(allocation.id);
      if (properties.presentation !== 'paragraph') return fallback('presentation');
      const rootRun = change.rootRuns.get(id) ?? prior?.boundaries[0]?.address.slot.run;
      if (!rootRun) return fallback('missing-root-run');
      const flow = ownership.runLayout(rootRun).flow;
      if (resourceKey(flow) !== resourceKey(allocation.flow))
        return fallback('incompatible-root-run');
      const absorbed = resourceKey(ownership.flowBlock(flow)) !== id;
      const birth =
        (allocation.id.birth.type === 'genesis' ||
          change.activity.isActive(allocation.id.birth.action)) &&
        interpretations.birthEnabled(allocation.id);
      let output: ViewNode | undefined;
      if (!absorbed) {
        const seed: ViewNode = {
          ...(prior ?? {
            origin: freeze({
              type: 'node' as const,
              representative: allocation.id,
              constituents: [allocation.id],
            }),
            type: 'paragraph',
            marker: properties.marker,
            info: properties.info,
            checked: properties.checked,
            children: Object.freeze([]),
            content: '',
            boundaries: [],
            fragments: [],
            wrappers: Object.freeze([]),
          }),
          edge: freeze({ type: 'edge' as const, child: allocation.id, slot: placement!.slot }),
        };
        output = projectInline(
          seed,
          ownership,
          native,
          interpretations,
          visible,
          tapeHomes,
          rootRun,
        );
      }
      const requirements = change.requirements.get(id) ?? before.nodeRequirements.get(id);
      if (!requirements) return fallback('missing-destination-witnesses');
      nodeRequirements.set(id, requirements);
      const kept =
        birth ||
        requirements.some(change.activity.isEffectActive) ||
        output?.fragments.some((f) => visible(f.range)) === true;
      nodeVisibility.set(
        id,
        freeze({
          node: allocation.id,
          tags: [],
          deleted: false,
          suppressed: !birth && !kept,
          scaffold: !birth && kept,
          available: kept,
        }),
      );
      for (const tape of prior ? readerTapes(prior) : [])
        tapeNodes.set(
          tape,
          (tapeNodes.get(tape) ?? []).filter((node) => node !== id),
        );
      if (output && kept) {
        nodes.set(id, { node: output, parent: parentId!, depth: parent.depth + 1 });
        membership.set(id, id);
        rootOutputs.set(id, [id]);
        for (const tape of readerTapes(output))
          tapeNodes.set(tape, [...(tapeNodes.get(tape) ?? []), id]);
      } else {
        nodes.delete(id);
        membership.delete(id);
        rootOutputs.set(id, []);
      }
      inlineCount += Number(!!output && kept) - Number(!!prior);
      countWork('projection.rawFlowRecordsBuilt');
      touchWork('projection.rawFlowRecords', id);
    }
    for (const [parentId, parent] of changedParents) {
      const children: ViewNode[] = [],
        seen = new Set<string>(),
        rawChildren = new Map<string, readonly NodeId[]>();
      for (const container of parent.origin.constituents) {
        const ordered = ownership.children(container);
        rawChildren.set(resourceKey(container), ordered);
        for (const raw of ordered)
          for (const id of rootOutputs.get(resourceKey(raw)) ?? []) {
            if (seen.has(id)) {
              if (key(children.at(-1)!) !== id) return fallback('normalized-constituent-split');
              continue;
            }
            const record = nodes.get(id);
            if (!record) return fallback('missing-normalized-output');
            children.push(record.node);
            seen.add(id);
          }
      }
      countWork('projection.parentChildEntriesCopied', children.length);
      countWork('projection.parentChildEntriesInspected', parent.children.length + children.length);
      const oldEdges = new Set(
        parent.children.slice(1).map((n, i) => `${key(parent.children[i])}|${key(n)}`),
      );
      for (let i = 1; i < children.length; i++)
        if (
          children[i].type === children[i - 1].type &&
          ['list', 'block-quote'].includes(children[i].type) &&
          !oldEdges.has(`${key(children[i - 1])}|${key(children[i])}`)
        )
          return fallback('wrapper-boundary');
      if (children[0]?.type === 'section' && children[0] !== parent.children[0])
        return fallback('section-range');
      let sectionSeen = false;
      for (const child of children) {
        if (child.type === 'section') sectionSeen = true;
        else if (sectionSeen && affected.has(key(child))) return fallback('section-range');
      }
      if (!children.length && ['block-quote', 'list-item', 'list'].includes(parent.type))
        return fallback('empty-container-region');
      // Paragraph leaves do not trigger any shared one-pass rule. Wrapper
      // constituents and section boundaries outside this closed gap are fixed.
      const wrappers = parent.wrappers.map((wrapper) => {
        const last = rawChildren.get(resourceKey(wrapper.node))?.at(-1);
        const predecessor = last ? ownership.blockPlacement(last)!.occurrence : null;
        if (
          (!predecessor && !wrapper.end.predecessor) ||
          (predecessor &&
            wrapper.end.predecessor &&
            resourceKey(predecessor) === resourceKey(wrapper.end.predecessor))
        )
          return wrapper;
        return freeze({ ...wrapper, end: { ...wrapper.end, predecessor } });
      });
      changedParents.set(
        parentId,
        Object.freeze({
          ...parent,
          children: Object.freeze(children),
          wrappers: Object.freeze(wrappers),
        }),
      );
      for (const child of children) {
        const record = nodes.get(key(child))!;
        if (record.parent !== parentId) return fallback('changed-normalized-parent');
      }
      countWork('projection.normalizationInertRegions');
    }
    replaceViewPaths(nodes, changedParents);
    const nextRoot = nodes.get(rootKey)!.node;
    const commandIndex = before.commandIndex.refine(nextRoot);
    registerCommandViewIndex(nextRoot, commandIndex);
    const visibility = resourceVisibility(tapes, updated.text, nodeVisibility);
    const value: Projection = {
      view: Object.freeze({
        root: nextRoot,
        emptyRoot: inlineCount
          ? null
          : freeze({
              type: 'empty-root' as const,
              slot: { parent: root.origin.representative, predecessor: null },
            }),
      }),
      ownership,
      activity: projectedActivity(change.activity, interpretations),
      interpretations,
      visibility,
    };
    registerAddressIndex(ownership, visibility, {
      allocations: nodeAllocations,
      visibility: nodeVisibility,
      flowHomes,
    });
    const state: State = {
      ...before,
      value,
      nodes,
      nodeVisibility,
      nodeAllocations,
      flowHomes,
      tapeHomes,
      rootOutputs,
      tapeNodes,
      nodeRequirements,
      membership,
      inlineCount,
      text: updated.text,
      deletions: updated.deletions,
      tapes,
      source,
      commandIndex,
    };
    countWork('projection.localStructuralCandidates');
    let committed = false;
    return {
      state: 'prepared' as const,
      value,
      revision: change.revision,
      commit: () => {
        if (committed || generation !== this.generation || this.state !== before)
          throw new Error('Projection candidate is no longer current');
        change.structure.commit();
        committed = true;
        this.state = state;
        this.counts.localStructuralProjections++;
        // The caller owns the supplied structural branch. Never reuse this module's
        // unrelated old replay cache after externally prepared structure is committed.
        this.ownership.evict();
      },
    };
  }
  private localText(before: State, changes: readonly ActionEnvelope[]): boolean {
    const tapes = new Set<string>();
    for (const action of changes) {
      for (const birth of action.nativeManifest) tapes.add(resourceKey(birth.tape));
      for (const effect of action.effects)
        if (effect.type === 'DeleteText')
          for (const range of effect.observed) tapes.add(resourceKey(range.tape));
    }
    for (const tape of tapes) {
      if (before.unsafeTextTapes.has(tape)) return false;
      if (!before.tapeNodes.get(tape)?.length) return false;
      for (const id of before.tapeNodes.get(tape) ?? []) {
        const visibility = before.nodeVisibility.get(id);
        if (
          !visibility?.available ||
          visibility.deleted ||
          visibility.suppressed ||
          visibility.scaffold
        )
          return false;
      }
    }
    return true;
  }
  canStageText(action: ActionEnvelope): boolean {
    return !!this.state && isTextRefinement(action) && this.localText(this.state, [action]);
  }
  /** The writer supplies its exact pre-append native draft. Derive selection only;
   * neither activity nor structural/projection roots are committed here.
   */
  stageText(
    actions: ActionSequence,
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
  ): Projection | undefined {
    const before = this.state,
      action = actions.at(-1)!;
    if (!before || !this.canStageText(action)) return undefined;
    const touched = [
      ...new Map(
        action.nativeManifest.map((birth) => [resourceKey(birth.tape), birth.tape]),
      ).values(),
    ];
    const structure = this.ownership.prepareText(actions, native, activity, variants, touched);
    if (!structure) return undefined;
    try {
      const state = this.append(before, action, structure.value, touched, native, activity);
      this.counts.stagedTextProjections++;
      return state.value;
    } finally {
      this.ownership.cancel();
    }
  }
  canStageProperties(action: ActionEnvelope): boolean {
    return !!this.state && isPropertyRefinement(action);
  }
  stageProperties(
    actions: ActionSequence,
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
    initial: ProjectionInput['initialProperties'],
  ): Projection | undefined {
    if (!this.state || !this.canStageProperties(actions.at(-1)!)) return undefined;
    const prepared = this.ownership.prepareProperties(actions, native, activity, variants, []);
    if (!prepared) return undefined;
    try {
      const state = this.appendProperties(
        this.state,
        prepared.changes,
        prepared.value,
        activity,
        initial,
        false,
      );
      if (state) this.counts.stagedPropertyProjections++;
      return state?.value;
    } finally {
      this.ownership.cancel();
    }
  }
  private appendProperties(
    before: State,
    changes: readonly ActionEnvelope[],
    ownership: OwnershipResult,
    activity: Activity,
    initial: ProjectionInput['initialProperties'],
    control: boolean,
  ): State | undefined {
    return measure('visibility-normalization', () =>
      this.appendPropertiesMeasured(before, changes, ownership, activity, initial, control),
    );
  }
  private appendPropertiesMeasured(
    before: State,
    changes: readonly ActionEnvelope[],
    ownership: OwnershipResult,
    activity: Activity,
    initial: ProjectionInput['initialProperties'],
    control: boolean,
  ): State | undefined {
    const changed = new Map<string, ViewNode>();
    const propertyBase = control
        ? withIndexedMasks(selectInterpretations(activity, initial), before.masks)
        : before.propertyBase,
      properties = control ? new PersistentMap<PresentedProperties>() : before.properties.fork();
    if (!control)
      for (const action of changes)
        for (const effect of action.effects) {
          if (effect.type !== 'SetProperties') return undefined;
          const id = resourceKey(effect.node);
          properties.set(id, {
            ...(properties.get(id) ?? propertyBase.properties(effect.node)),
            ...effect.values,
          });
        }
    const interpretations = control ? propertyBase : propertyOverlay(propertyBase, properties);
    for (const action of changes)
      for (const effect of action.effects) {
        if (effect.type !== 'SetProperties') return undefined;
        const id = resourceKey(effect.node),
          record = before.nodes.get(id);
        // Normalized-away constituents must not change their representative's
        // properties. Structural projection handles hidden/merged origins.
        if (!record || record.node.origin.constituents.length !== 1) return undefined;
        const node = record.node,
          properties = interpretations.properties(effect.node);
        if (node.info !== properties.info || node.checked !== properties.checked)
          changed.set(
            id,
            Object.freeze({ ...node, info: properties.info, checked: properties.checked }),
          );
      }
    const { nodes, commandIndex, replaced } = replaceViews(before, changed);
    this.counts.projectionRecordsReplaced += replaced;
    const value: Projection = {
      ...before.value,
      view: Object.freeze({
        ...before.value.view,
        root: nodes.get(key(before.value.view.root))!.node,
      }),
      ownership,
      activity: projectedActivity(activity, interpretations),
      interpretations,
    };
    registerAddressIndex(ownership, value.visibility, {
      allocations: before.nodeAllocations,
      visibility: before.nodeVisibility,
      flowHomes: before.flowHomes,
    });
    return { ...before, value, nodes, commandIndex, propertyBase, properties };
  }
  /** Complete pre-append selection projection over an isolated structural
   * branch. The full projector still validates and normalizes the author result.
   * It consumes suffix-replayed raw structure rather than reconstructing it.
   */
  stageStructure(
    input: ProjectionInput,
    activity: Activity,
    variants: PayloadIndex,
    sequence?: ActionSequence,
  ): Projection | undefined {
    return measure(
      'visibility-normalization',
      () => this.stageStructureMeasured(input, activity, variants, sequence),
      'staging',
    );
  }
  private stageStructureMeasured(
    input: ProjectionInput,
    activity: Activity,
    variants: PayloadIndex,
    sequence?: ActionSequence,
  ): Projection | undefined {
    const branch = this.ownership.fork();
    if (!branch) return undefined;
    const action = input.actions.at(-1)!.action;
    const touched = [
      ...new Map(
        action.nativeManifest.map((entry) => [resourceKey(entry.tape), entry.tape]),
      ).values(),
    ];
    try {
      const structure = finish(
        measureWork('coupled-replay', branch.prepare(input, activity, variants, touched, sequence)),
      );
      const visibility = indexedVisibility(
        this.state,
        input.actions.map((a) => a.action),
        sequence && readySource(sequence),
        this.counts,
      );
      const value = projectWithActivity(input, activity, {
        ...structure.value,
        visibility: visibility.reduce,
      });
      this.counts.stagedStructuralProjections++;
      return value;
    } finally {
      const work = branch.diagnostics();
      this.counts.stagedStructureActionsReplayed += work.actionsReplayed;
      this.counts.stagedStructureTapesRead += work.nativeTapeReads;
      branch.cancel();
    }
  }
  private updateText(
    before: State,
    action: ActionEnvelope,
    ownership: OwnershipResult,
    touched: readonly TapeId[],
    native: NativeView,
    groupActivity: Activity,
    changes: readonly ActionEnvelope[],
    control: boolean,
  ) {
    const text = before.text.fork(),
      deletions = before.deletions.update(
        changes,
        (ref) =>
          groupActivity.isEffectActive(ref) && before.value.interpretations.effectEligible(ref),
        this.counts,
      );
    const affected = new Set<string>();
    const nativeTapes = new Set(touched.map(resourceKey));
    const semanticTapes = new Map(touched.map((tape) => [resourceKey(tape), tape]));
    for (const changed of changes) {
      for (const effect of changed.effects)
        if (effect.type === 'DeleteText')
          for (const range of effect.observed) {
            semanticTapes.set(resourceKey(range.tape), range.tape);
            for (const node of ownership.inlineOwner(range)) affected.add(resourceKey(node));
          }
      if (control)
        for (const birth of changed.nativeManifest)
          if (birth.type === 'text') {
            semanticTapes.set(resourceKey(birth.tape), birth.tape);
            for (const node of ownership.inlineOwner({ tape: birth.tape, ...birth.native }))
              affected.add(resourceKey(node));
          }
    }
    const hasMarkers = action.allocations.some((allocation) => allocation.type === 'marker');
    for (const [id, tape] of semanticTapes) {
      if (hasMarkers && nativeTapes.has(id))
        for (const node of before.tapeNodes.get(id) ?? []) affected.add(node);
      const old = new Map(text.get(id)?.byId);
      for (const birth of action.nativeManifest)
        if (birth.type === 'text' && resourceKey(birth.tape) === id) {
          for (let i = 0; i < birth.native.length; i++) {
            const token = {
              tape,
              native: { client: birth.native.client, clock: birth.native.clock + i },
              birth: action.id,
            };
            old.set(tokenKey(token.native), {
              token,
              insertionActive: true,
              tags: [],
              deletedDestination: false,
              visible: true,
            });
          }
          for (const node of ownership.inlineOwner({ tape, ...birth.native }))
            affected.add(resourceKey(node));
        }
      const newDeletes = changes.flatMap((changed) =>
        changed.effects.flatMap((effect) =>
          effect.type === 'DeleteText'
            ? effect.observed.filter((range) => resourceKey(range.tape) === id)
            : [],
        ),
      );
      const covers = (range: NativeTextRange, entry: TextVisibility) =>
        range.client === entry.token.native.client &&
        range.clock <= entry.token.native.clock &&
        entry.token.native.clock < range.clock + range.length;
      for (const [key, entry] of old) {
        if (!control && !newDeletes.some((range) => covers(range, entry))) continue;
        const tags = deletions.tags(entry.token, this.counts);
        const insertionActive =
          control && entry.token.birth !== null
            ? groupActivity.isActive(entry.token.birth)
            : entry.insertionActive;
        if (
          entry.insertionActive === insertionActive &&
          entry.tags.length === tags.length &&
          entry.tags.every((tag, i) => resourceKey(tag) === resourceKey(tags[i]))
        )
          continue;
        old.set(key, {
          ...entry,
          insertionActive,
          tags,
          visible: insertionActive && !tags.length && !entry.deletedDestination,
        });
      }
      const home = nativeTapes.has(id) && before.tapeHomes.get(id);
      if (nativeTapes.has(id) && !home)
        throw new Error('Text change lacks a retained private home');
      // Ordering still visits retained text on the affected tape. Read its open
      // home interval without exporting/cloning a complete marker snapshot.
      const entries = home
        ? native.range(home).flatMap((part) =>
            Array.from({ length: part.text.length }, (_, i) => {
              const entry = old.get(
                tokenKey({ client: part.range.client, clock: part.range.clock + i }),
              );
              if (!entry) throw new Error('Text change contains an uncertified native identity');
              return entry;
            }),
          )
        : (text.get(id)?.entries ?? []).map((entry) => old.get(tokenKey(entry.token.native))!);
      text.set(id, { entries, byId: old });
      this.counts.textTapesRebuilt++;
    }
    return { text, deletions, affected };
  }
  private append(
    before: State,
    action: ActionEnvelope,
    ownership: OwnershipResult,
    touched: readonly TapeId[],
    native: NativeView,
    groupActivity: Activity,
    changes: readonly ActionEnvelope[] = [action],
    control = false,
  ): State {
    return measure('visibility-normalization', () =>
      this.appendMeasured(
        before,
        action,
        ownership,
        touched,
        native,
        groupActivity,
        changes,
        control,
      ),
    );
  }
  private appendMeasured(
    before: State,
    action: ActionEnvelope,
    ownership: OwnershipResult,
    touched: readonly TapeId[],
    native: NativeView,
    groupActivity: Activity,
    changes: readonly ActionEnvelope[] = [action],
    control = false,
  ): State {
    const { text, deletions, affected } = this.updateText(
      before,
      action,
      ownership,
      touched,
      native,
      groupActivity,
      changes,
      control,
    );
    const changed = new Map<string, ViewNode>();
    const visible = (range: NativeTextRange) =>
      text.get(resourceKey(range.tape))?.byId.get(tokenKey(range))?.visible === true;
    for (const id of affected) {
      const record = before.nodes.get(id);
      if (!record) throw new Error('Text change changed an unavailable projected owner');
      changed.set(
        id,
        projectInline(
          record.node,
          ownership,
          native,
          before.value.interpretations,
          visible,
          before.tapeHomes,
        ),
      );
    }
    const { nodes, commandIndex, replaced } = replaceViews(before, changed);
    this.counts.projectionRecordsReplaced += replaced;
    const interpretations = before.value.interpretations;
    const value: Projection = {
      view: Object.freeze({
        root: nodes.get(key(before.value.view.root))!.node,
        emptyRoot: before.value.view.emptyRoot,
      }),
      ownership,
      activity: projectedActivity(groupActivity, interpretations),
      interpretations,
      visibility: textVisibility(before.tapes, text, before.value.visibility.nodes),
    };
    registerAddressIndex(ownership, value.visibility, {
      allocations: before.nodeAllocations,
      visibility: before.nodeVisibility,
      flowHomes: before.flowHomes,
    });
    return { ...before, value, nodes, text, deletions, commandIndex };
  }
  cancel(): void {
    this.generation++;
    this.ownership.cancel();
  }
  evict(): void {
    this.cancel();
    this.state = undefined;
    this.ownership.evict();
  }
}

export type PreparedProjection =
  ReturnType<MaterializedProjection['prepare']> extends Generator<void, infer T, void> ? T : never;
