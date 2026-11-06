import { countWork, measureWork, touchWork } from '../diagnostics.js';
import { measure } from '../diagnostics.js';
import { readySource } from '../authoring/ready-source.js';
import type { ReadySequence, ReadySource } from '../authoring/ready-source.js';
import { actionKey } from '../actions/references.js';
import type {
  ActionEnvelope,
  FlowId,
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
import type { PresentedProperties } from '../projection/interpretation.js';
import { isPropertyRefinement } from './properties.js';
import { finish } from '../ingest/work.js';
import { ExactTextDeletions } from './text-deletions.js';
import type { TextDeletionWork } from './text-deletions.js';
import { reduceVisibilityWithTextTags } from '../visibility/visibility.js';
import type { reduceVisibility } from '../visibility/visibility.js';
import type { StructuralProjectionChange } from './projection-changes.js';
import { MaterializedInterpretations } from './interpretations.js';
import { indexNormalization, projectNormalizationRegion } from './projection-region.js';
import { SubtreeDeletions } from './subtree-deletions.js';
import { compareEffects } from '../contracts.js';
import { VisibilityWitnesses } from './visibility-witnesses.js';
import { SplitVisibility } from './split-visibility.js';
import { deletionEffectKey } from './subtree-deletions.js';
import { ProjectionOrder } from './projection-order.js';
import { projectionChange } from './projection-adapter.js';
import type { ProducerBinding } from './projection-adapter.js';

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
  changed?: readonly ActionEnvelope[],
) {
  let index: ExactTextDeletions | undefined;
  const reduce: typeof reduceVisibility = (activity, layout, tokens, birthEnabled = () => true) => {
    if (!index) {
      const changes = changed ?? semanticAdditions(before, source)?.changes;
      index =
        changes && before
          ? before.deletions.update(changes, activity.isEffectActive, work)
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
/** Retained payload identity comes from ReadySource. Controls also change their
 * targets' semantic contributions; packet selection is handled separately. */
function semanticAdditions(before: State | undefined, source: ReadySource | undefined) {
  const additions = source && before?.source && source.additions(before.source);
  if (!additions) return undefined;
  const changes = new Map(additions.actions.map((a) => [actionKey(a.id), a]));
  for (const action of additions.actions)
    for (const effect of action.effects) {
      if (effect.type === 'SetGroupActive')
        for (const id of effect.actions) {
          const target = source.get(actionKey(id));
          if (!target) throw new Error('Control target is outside exact projection source');
          changes.set(actionKey(id), target);
        }
    }
  return { actions: additions.actions, changes: [...changes.values()] };
}
function interpretationCandidate(
  before: State | undefined,
  actions: Iterable<ActionEnvelope>,
  source: ReadySource | undefined,
  activity: Activity,
  initial: ProjectionInput['initialProperties'],
) {
  const delta = semanticAdditions(before, source);
  const candidate =
    before && delta ? before.interpretationIndex.update(delta.changes, activity) : undefined;
  const index = candidate?.index ?? MaterializedInterpretations.create(actions, activity, initial);
  if (!delta) return { index };
  const changes = new Map(delta.changes.map((a) => [actionKey(a.id), a]));
  for (const ref of candidate?.eligibility ?? []) {
    const action = source!.get(actionKey(ref.action));
    if (!action) throw new Error('Packet member is outside exact projection source');
    changes.set(actionKey(action.id), action);
  }
  return { index, delta: { ...delta, changes: [...changes.values()] } };
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
  readonly producerBase?: ProducerBinding;
  readonly value: Projection;
  readonly nodes: PersistentMap<NodeRecord>;
  readonly text: PersistentMap<TextTape>;
  readonly deletions: ExactTextDeletions;
  readonly source?: ReadySource;
  readonly subtrees: SubtreeDeletions;
  readonly nodeVisibility: PersistentMap<Projection['visibility']['nodes'][number]>;
  readonly nodeAllocations: PersistentMap<Extract<Allocation, { type: 'node' }>>;
  readonly flowHomes: PersistentMap<NodeId>;
  readonly flowRoots: PersistentMap<RunId>;
  readonly runFlows: PersistentMap<FlowId>;
  readonly tapeNodes: PersistentMap<readonly string[]>;
  readonly tapes: PersistentMap<TapeId>;
  readonly tapeHomes: PersistentMap<RangeRef>;
  readonly rootOutputs: PersistentMap<readonly string[]>;
  readonly nodeRequirements: PersistentMap<readonly EffectRef[]>;
  readonly requirementReaders: PersistentMap<readonly NodeId[]>;
  readonly witnesses: VisibilityWitnesses;
  readonly splitVisibility: SplitVisibility;
  readonly normalization: import('./projection-region.js').NormalizationDependencies;
  readonly membership: PersistentMap<string>;
  readonly inlineCount: number;
  readonly commandIndex: IndexedCommandView;
  readonly interpretationIndex: MaterializedInterpretations;
  readonly order: ProjectionOrder;
}
const key = (node: ViewNode) => resourceKey(node.origin.representative);
const tokenKey = (range: { readonly client: number; readonly clock: number }) =>
  `${range.client}:${range.clock}`;
type ViewRoots = Pick<
  State,
  'nodes' | 'rootOutputs' | 'tapeNodes' | 'membership' | 'inlineCount' | 'normalization'
>;
function projectionReaderTapes(node: ViewNode) {
  return new Set([
    ...node.boundaries.map((b) => resourceKey(b.address.origin.tape)),
    ...node.fragments.map((f) => resourceKey(f.range.tape)),
  ]);
}
function replaceRegionRecords(
  before: State,
  result: ReturnType<typeof projectNormalizationRegion>,
  ownership: OwnershipResult,
): ViewRoots {
  const rootKey = key(before.value.view.root);
  const nodes = before.nodes.fork(),
    tapeNodes = before.tapeNodes.fork(),
    membership = before.membership.fork(),
    rootOutputs = before.rootOutputs.fork();
  let inlineCount = before.inlineCount;
  const remove = (node: ViewNode) => {
    nodes.delete(key(node));
    for (const origin of node.origin.constituents) {
      membership.delete(resourceKey(origin));
      rootOutputs.delete(resourceKey(origin));
    }
    for (const tape of projectionReaderTapes(node))
      tapeNodes.set(
        tape,
        (tapeNodes.get(tape) ?? []).filter((id) => id !== key(node)),
      );
    if (['paragraph', 'section', 'code-block'].includes(node.type)) inlineCount--;
    for (const child of node.children) remove(child);
  };
  for (const node of result.removed) remove(node);
  const add = (node: ViewNode, depth: number, parent: string) => {
    nodes.set(key(node), { node, depth, parent });
    for (const origin of node.origin.constituents) membership.set(resourceKey(origin), key(node));
    for (const tape of projectionReaderTapes(node))
      tapeNodes.set(tape, [...(tapeNodes.get(tape) ?? []), key(node)]);
    if (['paragraph', 'section', 'code-block'].includes(node.type)) inlineCount++;
    for (const child of node.children) add(child, depth + 1, key(node));
    countWork('projection.regionViewRecordsIndexed');
  };
  for (const node of result.outputs) add(freeze(node), 1, rootKey);
  nodes.set(rootKey, { node: freeze(result.root), depth: 0 });
  const groups = (parent: ViewNode) => {
    const containers = new Set(parent.origin.constituents.map(resourceKey));
    for (const child of parent.children) {
      const tops = new Set<string>();
      for (const origin of child.origin.constituents) {
        let node = origin,
          placement = ownership.blockPlacement(node);
        while (placement && !containers.has(resourceKey(placement.slot.parent))) {
          node = placement.slot.parent;
          placement = ownership.blockPlacement(node);
        }
        if (placement) tops.add(resourceKey(node));
      }
      for (const top of tops) rootOutputs.set(top, [...(rootOutputs.get(top) ?? []), key(child)]);
      groups(child);
    }
  };
  groups({ ...result.root, children: result.outputs });
  return {
    nodes,
    tapeNodes,
    membership,
    rootOutputs,
    inlineCount,
    normalization: result.dependencies,
  };
}
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
function textVisibility(
  order: ProjectionOrder,
  text: State['text'],
  nodes: Projection['visibility']['nodes'],
): Projection['visibility'] {
  let allText: readonly TextVisibility[] | undefined;
  return {
    get text() {
      if (!allText) {
        const tapes = [...order.tapes()];
        countWork('projection.visibilityTapesExported', tapes.length);
        allText = tapes.flatMap((tape) => text.get(resourceKey(tape))?.entries ?? []);
      }
      return allText;
    },
    nodes,
  };
}
/** Publication getters own current roots only, never a preparation context. */
function resourceVisibility(
  order: ProjectionOrder,
  text: State['text'],
  nodes: State['nodeVisibility'],
): Projection['visibility'] {
  const textView = textVisibility(order, text, []);
  let allNodes: Projection['visibility']['nodes'] | undefined;
  return {
    get nodes() {
      if (!allNodes) {
        countWork('projection.visibilityNodesExported', nodes.size);
        allNodes = [...order.nodes()].map((node) => nodes.get(resourceKey(node))!);
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
  interpretationIndex: MaterializedInterpretations,
  source?: ReadySource,
  before?: State,
  delta?: ReturnType<typeof semanticAdditions>,
): State {
  return measure('visibility-normalization', () =>
    indexMeasured(value, input, deletions, interpretationIndex, source, before, delta),
  );
}
function indexMeasured(
  value: Projection,
  input: ProjectionInput,
  deletions: ExactTextDeletions,
  interpretationIndex: MaterializedInterpretations,
  source?: ReadySource,
  before?: State,
  delta?: ReturnType<typeof semanticAdditions>,
): State {
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
  const nodeVisibility = new PersistentMap<Projection['visibility']['nodes'][number]>();
  for (const entry of value.visibility.nodes) nodeVisibility.set(resourceKey(entry.node), entry);
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
  const tapeHomes = new PersistentMap<RangeRef>(),
    runFlows = new PersistentMap<FlowId>();
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
    else if (allocation.type === 'run') runFlows.set(resourceKey(allocation.id), allocation.flow);
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
  const added = delta?.actions.flatMap((a) => a.allocations.filter((a) => a.type === 'node'));
  const newIds = new Set(added?.map((a) => resourceKey(a.id)));
  const subtrees =
    before && delta
      ? before.subtrees.update(
          delta.changes,
          added!,
          input.birthContent.filter((entry) => newIds.has(resourceKey(entry.node))),
          value.activity,
          [],
          (marker) => input.native.marker(marker).index,
        ).index
      : SubtreeDeletions.create(
          value.activity.actions,
          nodeAllocations.values(),
          input.birthContent,
          value.activity,
          (marker) => input.native.marker(marker).index,
        );
  const flowRoots = new PersistentMap<RunId>();
  for (const home of value.ownership.homeBindings) {
    flowRoots.set(resourceKey(value.ownership.runLayout(home.run).flow), home.run);
    countWork('projection.flowRootsIndexed');
  }
  const requirementReaders = new PersistentMap<readonly NodeId[]>();
  for (const [id, refs] of nodeRequirements)
    for (const ref of refs) {
      const key = deletionEffectKey(ref);
      requirementReaders.set(key, [
        ...(requirementReaders.get(key) ?? []),
        nodeAllocations.get(id)!.id,
      ]);
    }
  const splitVisibility = SplitVisibility.create(
    value.activity.actions,
    value.ownership,
    flowHomes,
    value.activity,
    subtrees,
  );
  const witnesses = VisibilityWitnesses.create(nodeAllocations.values(), value.visibility, {
    ownership: value.ownership,
    runFlows,
    activity: value.activity,
    birthEnabled: (node) =>
      value.interpretations.birthEnabled(node) && !splitVisibility.hidden(node),
    requirements: (node) =>
      (nodeRequirements.get(resourceKey(node)) ?? []).filter((ref) => splitVisibility.permits(ref)),
  });
  return {
    value,
    nodes,
    text,
    deletions,
    source,
    subtrees,
    nodeVisibility,
    nodeAllocations,
    flowHomes,
    flowRoots,
    runFlows,
    tapeNodes,
    commandIndex,
    tapeHomes,
    rootOutputs,
    nodeRequirements,
    requirementReaders,
    witnesses,
    splitVisibility,
    normalization: indexNormalization(
      value.view.root,
      value.ownership,
      value.interpretations,
      nodeVisibility,
    ),
    membership,
    inlineCount,
    interpretationIndex,
    order:
      before && delta
        ? before.order.add(delta.actions)
        : ProjectionOrder.create(
            input.genesis.allocations,
            input.actions.map((a) => a.action),
          ),
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
    const compatibleBefore = before?.producerBase?.genesis === genesis.layout ? before : undefined;
    let suffix = compatibleBefore
      ? this.ownership.prepareText(actions, native, activity, variants)
      : undefined;
    if (suffix && before && !this.localText(before, suffix.changes)) {
      this.ownership.cancel();
      suffix = undefined;
    }
    const properties =
      !suffix && compatibleBefore
        ? this.ownership.prepareProperties(actions, native, activity, variants)
        : undefined;
    const propertyState =
      properties && before
        ? this.appendProperties(before, properties.changes, properties.value, activity)
        : undefined;
    let state: State, commitStructure: () => void, assertStructure: () => void;
    let producerBase: ProducerBinding;
    let localStructural = false;
    if (propertyState && properties) {
      yield;
      state = propertyState;
      commitStructure = properties.commit;
      assertStructure = properties.assertCurrent;
      producerBase = properties.structuralChanges.candidate;
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
      assertStructure = suffix.assertCurrent;
      producerBase = suffix.structuralChanges.candidate;
      this.counts.localTextProjections++;
    } else {
      const prepared = yield* measureWork(
        'coupled-replay',
        this.ownership.prepareReady(
          {
            genesis: genesis.layout,
            genesisManifest: genesis.body.nativeManifest,
            initialProperties: genesis.initialProperties,
            actions,
            native,
          },
          activity,
          variants,
        ),
      );
      yield;
      const adapted = before
        ? projectionChange(before, prepared, actions, native, activity)
        : undefined;
      const local =
        adapted?.state === 'adapted'
          ? this.buildStructuralState(before, adapted.change)
          : undefined;
      if (local?.state === 'prepared') {
        state = local.roots;
        localStructural = true;
      } else {
        const reason =
          local?.state === 'fallback'
            ? local.reason
            : adapted?.state === 'fallback'
              ? adapted.reason
              : 'cold';
        countWork(`projection.fullFallback.${reason}`);
        const input: ProjectionInput = {
          genesis: genesis.layout,
          genesisManifest: genesis.body.nativeManifest,
          initialProperties: genesis.initialProperties,
          ...reconstructProvenance(genesis.layout, [...actions]),
          native,
        };
        const selection = interpretationCandidate(
          compatibleBefore,
          actions,
          readySource(actions),
          activity,
          genesis.initialProperties,
        );
        const visibility = indexedVisibility(
          compatibleBefore,
          actions,
          readySource(actions),
          this.counts,
          selection.delta?.changes,
        );
        const value = projectWithActivity(input, activity, {
          ownership: prepared.value.ownership,
          snapshots: prepared.value.snapshots,
          visibility: visibility.reduce,
          interpretations: selection.index.value(),
        });
        state = index(
          value,
          input,
          visibility.root(),
          selection.index,
          readySource(actions),
          compatibleBefore,
          selection.delta,
        );
        this.counts.fullProjections++;
      }
      commitStructure = prepared.commit;
      assertStructure = prepared.assertCurrent;
      producerBase = prepared.value.changes.candidate;
    }
    state = { ...state, source: readySource(actions), producerBase };
    let committed = false;
    const assertCurrent = () => {
      if (committed || generation !== this.generation || this.state !== before)
        throw new Error('Projection candidate is no longer current');
      assertStructure();
    };
    return {
      value: state.value,
      assertCurrent,
      commit: () => {
        assertCurrent();
        commitStructure();
        committed = true;
        this.state = state;
        if (localStructural) this.counts.localStructuralProjections++;
      },
    };
  }
  /** Prepare C roots from an exact producer delta. No structural decisions are
   * replayed here. Closed paragraph gaps retain their real normalized container
   * and wrapper context. Other regions return a named reconstruction condition.
   */
  prepareStructural(change: StructuralProjectionChange) {
    return measure('visibility-normalization', () => {
      const generation = ++this.generation,
        before = this.state;
      const result = this.buildStructuralState(before, change);
      if (result.state === 'fallback') return result;
      let committed = false;
      const assertCurrent = () => {
        if (committed || generation !== this.generation || this.state !== before)
          throw new Error('Projection candidate is no longer current');
        change.structure.assertCurrent?.();
      };
      return {
        state: 'prepared' as const,
        value: result.value,
        revision: change.revision,
        assertCurrent,
        commit: () => {
          assertCurrent();
          change.structure.commit();
          committed = true;
          this.state = result.roots;
          this.counts.localStructuralProjections++;
          // Controlled callers supply an external producer.
          this.ownership.evict();
        },
      };
    });
  }
  private buildStructuralState(before: State | undefined, change: StructuralProjectionChange) {
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
    countWork('projection.readyIndexNodesVisited', additions?.nodesVisited ?? 0);
    if (!additions?.actions.length || !additions.actions.includes(change.action))
      return fallback('missing-exact-addition');
    const fresh = additions.actions,
      order = before.order.add(fresh),
      changedActions = new Map(fresh.map((a) => [actionKey(a.id), a]));
    for (const changed of change.semanticChanges) {
      const action = source!.get(actionKey(changed.id));
      if (!action) return fallback('missing-semantic-action');
      changedActions.set(actionKey(action.id), action);
    }
    for (const action of fresh)
      for (const effect of action.effects)
        if (effect.type === 'SetGroupActive')
          for (const id of effect.actions) {
            const target = source!.get(actionKey(id));
            if (!target) return fallback('missing-control-target');
            changedActions.set(actionKey(target.id), target);
          }
    const selection = before.interpretationIndex.update(changedActions.values(), change.activity),
      interpretationIndex = selection.index,
      interpretations = interpretationIndex.value();
    for (const ref of selection.eligibility) {
      const action = source!.get(actionKey(ref.action));
      if (!action) return fallback('missing-packet-member');
      changedActions.set(actionKey(action.id), action);
    }
    const semanticChanges = [...changedActions.values()];
    let normalizationReason: string | undefined;
    for (const action of semanticChanges)
      for (const effect of action.effects) {
        if (effect.type === 'SetProperties') {
          const properties = before.value.interpretations.properties(effect.node),
            candidate = interpretations.properties(effect.node);
          if (
            [...new Set([...Object.keys(properties), ...Object.keys(candidate)])].every(
              (name) =>
                properties[name as keyof PresentedProperties] ===
                candidate[name as keyof PresentedProperties],
            )
          )
            continue;
          normalizationReason ??= 'properties';
        } else if (effect.type === 'LiftChildren' && effect.placements.length)
          normalizationReason ??= 'lifting';
        else if (
          effect.type === 'MoveBlock' &&
          change.structure.value.nodeAllocation(effect.node).role !== 'inline'
        )
          normalizationReason ??= 'wrapper-placement';
        else if (effect.type === 'JoinFlow' && effect.liftedChildren.length)
          normalizationReason ??= 'child-lifting';
        else if (effect.type === 'Interpret' || effect.type === 'TransferRange')
          normalizationReason ??= effect.type;
      }
    const ownership = change.structure.value,
      native = change.native,
      root = before.value.view.root,
      rootKey = key(root);
    const nodeAllocations = before.nodeAllocations.fork(),
      flowHomes = before.flowHomes.fork(),
      flowRoots = before.flowRoots.fork(),
      runFlows = before.runFlows.fork(),
      tapeHomes = before.tapeHomes.fork(),
      nodeRequirements = before.nodeRequirements.fork(),
      requirementReaders = before.requirementReaders.fork();
    const tapes = before.tapes.fork();
    for (const allocation of fresh.flatMap((a) => a.allocations)) {
      if (allocation.type === 'node') {
        nodeAllocations.set(resourceKey(allocation.id), allocation);
        if (allocation.flow && !flowHomes.has(resourceKey(allocation.flow)))
          flowHomes.set(resourceKey(allocation.flow), allocation.id);
      } else if (allocation.type === 'run') {
        runFlows.set(resourceKey(allocation.id), allocation.flow);
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
    const newNodes = fresh.flatMap((a) => a.allocations.filter((a) => a.type === 'node')),
      newNodeKeys = new Set(newNodes.map((a) => resourceKey(a.id)));
    if (
      change.birthContent.length !== newNodeKeys.size ||
      new Set(change.birthContent.map((b) => resourceKey(b.node))).size !== newNodeKeys.size ||
      change.birthContent.some((b) => !newNodeKeys.has(resourceKey(b.node)))
    )
      return fallback('missing-birth-coverage');
    for (const node of [...change.nodes, ...change.containers, ...newNodes.map((a) => a.id)]) {
      const id = resourceKey(node),
        allocation = nodeAllocations.get(id);
      if (!allocation) return fallback('unknown-resource');
      if (!change.requirements.has(id)) return fallback('missing-destination-witnesses');
      if (
        allocation.flow &&
        (newNodeKeys.has(id) || change.nodes.some((n) => resourceKey(n) === id))
      ) {
        const run = change.rootRuns.get(id);
        if (!run) return fallback('missing-root-run');
        const retained = flowRoots.get(resourceKey(allocation.flow));
        if (
          resourceKey(ownership.runLayout(run).flow) !== resourceKey(allocation.flow) ||
          (retained && resourceKey(retained) !== resourceKey(run))
        )
          return fallback('incompatible-root-run');
        flowRoots.set(resourceKey(allocation.flow), run);
      }
    }
    for (const tape of [...change.tapes, ...change.nativeTapes])
      if (!tapeHomes.has(resourceKey(tape))) return fallback('unknown-native-resource');
    const affected = new Set(change.nodes.map(resourceKey));
    for (const node of [...selection.nodes, ...selection.births]) affected.add(resourceKey(node));
    affected.delete(rootKey);
    for (const tape of [...change.tapes, ...selection.tapes])
      for (const id of before.tapeNodes.get(resourceKey(tape)) ?? []) affected.add(id);
    const coverage = before.subtrees.update(
      semanticChanges,
      fresh.flatMap((a) => a.allocations.filter((a) => a.type === 'node')),
      change.birthContent,
      projectedActivity(change.activity, interpretations),
      [],
      (marker) => native.marker(marker).index,
    );
    for (const tape of coverage.tapes)
      for (const id of before.tapeNodes.get(resourceKey(tape)) ?? []) affected.add(id);
    const activity = projectedActivity(change.activity, interpretations);
    const requirementNodes = new Set<string>();
    for (const [id, refs] of change.requirements) {
      const node = nodeAllocations.get(id)!.id;
      for (const old of nodeRequirements.get(id) ?? []) {
        const key = deletionEffectKey(old);
        requirementReaders.set(
          key,
          (requirementReaders.get(key) ?? []).filter((n) => resourceKey(n) !== id),
        );
      }
      for (const ref of refs) {
        const key = deletionEffectKey(ref);
        requirementReaders.set(key, [...(requirementReaders.get(key) ?? []), node]);
      }
      nodeRequirements.set(id, refs);
      requirementNodes.add(id);
    }
    const sources = new Map<string, NodeId>();
    const descendants = (node: NodeId) => {
      const id = resourceKey(node);
      if (sources.has(id)) return;
      sources.set(id, node);
      countWork('projection.visibilitySourceEdgesVisited');
      for (const child of ownership.children(node)) descendants(child);
    };
    for (const id of coverage.nodes) descendants(nodeAllocations.get(id)!.id);
    for (const node of change.nodes) {
      const old =
          before.nodeAllocations.has(resourceKey(node)) &&
          before.value.ownership.blockPlacement(node)?.slot.parent,
        after = ownership.blockPlacement(node)?.slot.parent;
      if ((old ? resourceKey(old) : null) !== (after ? resourceKey(after) : null))
        descendants(node);
    }
    const splitChange = before.splitVisibility.update(
        semanticChanges,
        sources.values(),
        ownership,
        flowHomes,
        activity,
        coverage.index,
      ),
      splitVisibility = splitChange.index;
    for (const node of splitChange.nodes) affected.add(resourceKey(node));
    for (const ref of splitChange.effects)
      for (const node of [
        ...(before.requirementReaders.get(deletionEffectKey(ref)) ?? []),
        ...(requirementReaders.get(deletionEffectKey(ref)) ?? []),
      ])
        requirementNodes.add(resourceKey(node));
    for (const id of coverage.nodes) affected.add(id);
    const visibilityDraft = before.witnesses.prepare({
      nodes: [...new Set([...affected, ...requirementNodes])].map(
        (id) => nodeAllocations.get(id)!.id,
      ),
      ownership,
      activity,
      birthEnabled: (node) => interpretations.birthEnabled(node) && !splitVisibility.hidden(node),
      requirements: (node) =>
        (nodeRequirements.get(resourceKey(node)) ?? []).filter((ref) =>
          splitVisibility.permits(ref),
        ),
      tags: (node) => coverage.index.nodeTags(node),
    });
    const destinationTapes = new Map(
      [...change.tapes, ...coverage.tapes].map((tape) => [resourceKey(tape), tape]),
    );
    for (const id of visibilityDraft.dirty) {
      if (before.nodeVisibility.get(id)?.deleted === visibilityDraft.draft.nodes.get(id)?.deleted)
        continue;
      affected.add(id);
      const allocation = nodeAllocations.get(id)!;
      if (!allocation.flow) continue;
      for (const source of [
        ownership,
        ...(before.nodeAllocations.has(id) ? [before.value.ownership] : []),
      ])
        for (const entry of source.raw(allocation.flow)) {
          const tape =
            entry.type === 'cell'
              ? entry.assignment.cell.tape
              : entry.type === 'slot'
                ? native.marker(entry.slot.boundary).tape
                : undefined;
          if (tape) destinationTapes.set(resourceKey(tape), tape);
          countWork('projection.destinationFlowEntriesInspected');
        }
    }
    const context = {
      ...before,
      runFlows,
      tapeHomes,
      subtrees: coverage.index,
      value: { ...before.value, interpretations },
    };
    const updated = this.updateText(
      context,
      change.action,
      ownership,
      change.nativeTapes,
      native,
      change.activity,
      semanticChanges,
      fresh.some((a) => a.effects.some((e) => e.type === 'SetGroupActive')),
      {
        tapes: [...destinationTapes.values()],
        deleted: (node) => visibilityDraft.draft.deleted(node),
      },
      fresh,
    );
    visibilityDraft.draft.replaceTapes(
      updated.tapes,
      updated.text,
      ownership,
      visibilityDraft.dirty,
      runFlows,
    );
    for (const id of visibilityDraft.draft.finish(visibilityDraft.dirty)) affected.add(id);
    const witnesses = visibilityDraft.draft;
    for (const id of updated.affected) affected.add(id);
    const nodes = before.nodes.fork(),
      nodeVisibility = witnesses.nodes,
      rootOutputs = before.rootOutputs.fork(),
      tapeNodes = before.tapeNodes.fork(),
      membership = before.membership.fork();
    let inlineCount = before.inlineCount;
    const parentFor = (raw: NodeId) => before.membership.get(resourceKey(raw));
    const visible = (range: NativeTextRange) =>
      updated.text.get(resourceKey(range.tape))?.byId.get(tokenKey(range))?.visible === true;
    const finalize = (
      roots: Pick<
        State,
        'nodes' | 'rootOutputs' | 'tapeNodes' | 'membership' | 'inlineCount' | 'normalization'
      >,
    ) => {
      const { nodes, rootOutputs, tapeNodes, membership, inlineCount, normalization } = roots;
      const nextRoot = nodes.get(rootKey)!.node;
      const commandIndex = before.commandIndex.refine(nextRoot);
      registerCommandViewIndex(nextRoot, commandIndex);
      const visibility = resourceVisibility(order, updated.text, nodeVisibility);
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
        flowRoots,
        runFlows,
        tapeHomes,
        rootOutputs,
        tapeNodes,
        nodeRequirements,
        requirementReaders,
        witnesses,
        splitVisibility,
        interpretationIndex,
        order,
        membership,
        inlineCount,
        text: updated.text,
        deletions: updated.deletions,
        subtrees: updated.subtrees,
        tapes,
        source,
        commandIndex,
        normalization,
      };
      countWork('projection.localStructuralCandidates');
      return { state: 'prepared' as const, value, roots: state, revision: change.revision };
    };
    const regional = (reason: string) => {
      countWork(`projection.normalizationBoundary.${reason}`);
      const result = projectNormalizationRegion({
        before: {
          root,
          ownership: before.value.ownership,
          dependencies: before.normalization,
          hasNode: (id) => before.nodeAllocations.has(id),
          node: (id) => before.nodes.get(id)?.node,
        },
        ownership,
        interpretations,
        visibility: nodeVisibility,
        affected: [...new Set([...affected, ...change.containers.map(resourceKey)])].map(
          (id) => nodeAllocations.get(id)!.id,
        ),
        rootRuns: change.rootRuns,
        flowRoots,
        projectInline: (seed, run) =>
          projectInline(
            before.nodes.get(key(seed))?.node
              ? {
                  ...seed,
                  boundaries: before.nodes.get(key(seed))!.node.boundaries,
                  fragments: before.nodes.get(key(seed))!.node.fragments,
                }
              : seed,
            ownership,
            native,
            interpretations,
            visible,
            tapeHomes,
            run,
          ),
      });
      return finalize(replaceRegionRecords(before, result, ownership));
    };
    const changedParents = new Map<string, ViewNode>();
    for (const container of change.containers) {
      const id = before.membership.get(resourceKey(container)),
        parent = id && before.nodes.get(id);
      if (!parent) return regional('unrepresented-container');
      changedParents.set(id!, parent.node);
    }
    if (normalizationReason) return regional(normalizationReason);
    for (const id of affected) {
      const allocation = nodeAllocations.get(id),
        prior = before.nodes.get(id)?.node;
      if (!allocation) return fallback('unknown-resource');
      if (!allocation.flow || allocation.role !== 'inline') {
        if (before.nodeVisibility.get(id) !== nodeVisibility.get(id))
          return regional('container-visibility');
        const parentId = parentFor(allocation.id),
          record = parentId && before.nodes.get(parentId);
        if (!record) return regional('unrepresented-container');
        changedParents.set(parentId!, record.node);
        continue;
      }
      // Marker subdivision can touch a directly deleted flow's retained ghost
      // slots. Its declaration still hides this header regardless of placement;
      // it has no projected record or availability witness to rebuild.
      if (nodeVisibility.get(id)?.deleted && !prior) continue;
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
        return regional('section-range');
      if (!['document', 'section', 'block-quote', 'list-item'].includes(parent.node.type))
        return regional('container-kind');
      const parentVisibility = before.nodeVisibility.get(resourceKey(placement!.slot.parent));
      if (!parentVisibility?.available || parentVisibility.deleted || parentVisibility.tags.length)
        return regional('parent-visibility');
      if (
        !before.nodeAllocations.has(id) &&
        allocation.birthSlot &&
        parentFor(allocation.birthSlot.parent) !== parentId
      )
        return regional('birth-coverage-region');
      if (oldParentId && oldParentId !== parentId) {
        const oldParent = before.nodes.get(oldParentId);
        if (!oldParent) return regional('former-normalization-parent');
        changedParents.set(oldParentId, oldParent.node);
      }
      changedParents.set(parentId!, parent.node);
      if (
        ownership.children(allocation.id).length ||
        (oldPlacement && before.value.ownership.children(allocation.id).length)
      )
        return regional('child-lifting');
      if (
        prior &&
        (prior.type !== 'paragraph' ||
          prior.children.length ||
          prior.origin.constituents.length !== 1 ||
          before.nodes.get(id)?.parent !== oldParentId)
      )
        return regional('normalization-region');
      const group = before.rootOutputs.get(id);
      if (group?.length && (group.length !== 1 || group[0] !== id))
        return regional('normalized-constituents');
      const properties = interpretations.properties(allocation.id);
      if (properties.presentation !== 'paragraph') return regional('presentation');
      const rootRun = change.rootRuns.get(id) ?? before.flowRoots.get(resourceKey(allocation.flow));
      if (!rootRun) return fallback('missing-root-run');
      const flow = ownership.runLayout(rootRun).flow;
      if (resourceKey(flow) !== resourceKey(allocation.flow))
        return fallback('incompatible-root-run');
      const absorbed = resourceKey(ownership.flowBlock(flow)) !== id;
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
      const kept = nodeVisibility.get(id)!.available;
      for (const tape of prior ? projectionReaderTapes(prior) : [])
        tapeNodes.set(
          tape,
          (tapeNodes.get(tape) ?? []).filter((node) => node !== id),
        );
      if (output && kept) {
        nodes.set(id, { node: output, parent: parentId!, depth: parent.depth + 1 });
        membership.set(id, id);
        rootOutputs.set(id, [id]);
        for (const tape of projectionReaderTapes(output))
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
      // An empty constituent can have joined this origin during cleanup across
      // an available barrier. Giving it content changes the one-pass grouping,
      // even when the normalized parent's own child sequence looks inert.
      if (parent.origin.constituents.length !== 1) return regional('merged-container');
      const children: ViewNode[] = [],
        seen = new Set<string>(),
        rawChildren = new Map<string, readonly NodeId[]>();
      for (const container of parent.origin.constituents) {
        const ordered = ownership.children(container);
        rawChildren.set(resourceKey(container), ordered);
        for (const raw of ordered)
          for (const id of rootOutputs.get(resourceKey(raw)) ?? []) {
            if (seen.has(id)) {
              if (key(children.at(-1)!) !== id) return regional('normalized-constituent-split');
              continue;
            }
            const record = nodes.get(id);
            if (!record) return regional('missing-normalized-output');
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
          return regional('wrapper-boundary');
      if (children[0]?.type === 'section' && children[0] !== parent.children[0])
        return regional('section-range');
      let sectionSeen = false;
      for (const child of children) {
        if (child.type === 'section') sectionSeen = true;
        else if (sectionSeen && affected.has(key(child))) return regional('section-range');
      }
      if (!children.length && ['block-quote', 'list-item', 'list'].includes(parent.type))
        return regional('empty-container-region');
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
        if (record.parent !== parentId) return regional('changed-normalized-parent');
      }
      countWork('projection.normalizationInertRegions');
    }
    replaceViewPaths(nodes, changedParents);
    const normalization = {
      inputs: before.normalization.inputs.fork(),
      outputs: before.normalization.outputs.fork(),
      boundaries: before.normalization.boundaries.fork(),
    };
    const nextRoot = nodes.get(rootKey)!.node,
      nextKeys = new Set(nextRoot.children.map(key));
    for (const old of root.children)
      if (!nextKeys.has(key(old))) {
        for (const input of normalization.inputs.get(key(old)) ?? []) {
          normalization.boundaries.delete(input);
          normalization.outputs.set(
            input,
            (normalization.outputs.get(input) ?? []).filter((id) => id !== key(old)),
          );
        }
        normalization.inputs.delete(key(old));
      }
    for (const child of nextRoot.children)
      if (before.nodes.get(key(child))?.node !== child) {
        const inputs = new Set(normalization.inputs.get(key(child)) ?? []);
        for (const origin of child.origin.constituents) {
          let current = origin,
            placement = ownership.blockPlacement(current);
          while (placement && resourceKey(placement.slot.parent) !== rootKey) {
            current = placement.slot.parent;
            placement = ownership.blockPlacement(current);
          }
          if (placement) inputs.add(resourceKey(current));
        }
        normalization.inputs.set(key(child), [...inputs]);
        for (const input of inputs) {
          normalization.boundaries.delete(input);
          if (!(normalization.outputs.get(input) ?? []).includes(key(child)))
            normalization.outputs.set(input, [
              ...(normalization.outputs.get(input) ?? []),
              key(child),
            ]);
        }
      }
    return finalize({ nodes, rootOutputs, tapeNodes, membership, inlineCount, normalization });
  }
  private localText(before: State, changes: readonly ActionEnvelope[]): boolean {
    const tapes = new Set<string>();
    for (const action of changes) {
      for (const birth of action.nativeManifest) tapes.add(resourceKey(birth.tape));
      for (const effect of action.effects)
        if (effect.type === 'DeleteText')
          for (const range of effect.observed) tapes.add(resourceKey(range.tape));
    }
    for (const tape of tapes) if (!before.tapeHomes.has(tape)) return false;
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
    _initial: ProjectionInput['initialProperties'],
  ): Projection | undefined {
    if (!this.state || !this.canStageProperties(actions.at(-1)!)) return undefined;
    const prepared = this.ownership.prepareProperties(actions, native, activity, variants, []);
    if (!prepared) return undefined;
    try {
      const state = this.appendProperties(this.state, prepared.changes, prepared.value, activity);
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
  ): State | undefined {
    return measure('visibility-normalization', () =>
      this.appendPropertiesMeasured(before, changes, ownership, activity),
    );
  }
  private appendPropertiesMeasured(
    before: State,
    changes: readonly ActionEnvelope[],
    ownership: OwnershipResult,
    activity: Activity,
  ): State | undefined {
    const changed = new Map<string, ViewNode>(),
      affected = new Map<string, NodeId>();
    let needsRegion = false;
    const interpretationIndex = before.interpretationIndex.update(changes, activity).index;
    const interpretations = interpretationIndex.value();
    for (const action of changes)
      for (const effect of action.effects) {
        if (effect.type !== 'SetProperties') return undefined;
        const id = resourceKey(effect.node),
          record = before.nodes.get(id);
        affected.set(id, effect.node);
        // Reconstruct raw constituents before applying properties to a merged
        // representative. Hidden writes must also remain available on revival.
        if (!record || record.node.origin.constituents.length !== 1) {
          needsRegion = true;
          continue;
        }
        const node = record.node,
          properties = interpretations.properties(effect.node);
        if (node.info !== properties.info || node.checked !== properties.checked)
          changed.set(
            id,
            Object.freeze({ ...node, info: properties.info, checked: properties.checked }),
          );
      }
    if (needsRegion) {
      const root = before.value.view.root;
      const result = projectNormalizationRegion({
        before: {
          root,
          ownership: before.value.ownership,
          dependencies: before.normalization,
          hasNode: (id) => before.nodeAllocations.has(id),
          node: (id) => before.nodes.get(id)?.node,
        },
        ownership,
        interpretations,
        visibility: before.nodeVisibility,
        affected: [...affected.values()],
        rootRuns: new Map(),
        flowRoots: before.flowRoots,
        projectInline: (seed) => {
          const prior = before.nodes.get(key(seed))?.node;
          if (!prior) throw new Error('Visible property target lacks a retained inline');
          return {
            ...seed,
            content: prior.content,
            boundaries: prior.boundaries,
            fragments: prior.fragments,
          };
        },
      });
      const roots = replaceRegionRecords(before, result, ownership),
        commandIndex = before.commandIndex.refine(result.root);
      registerCommandViewIndex(result.root, commandIndex);
      const value: Projection = {
        ...before.value,
        ownership,
        interpretations,
        activity: projectedActivity(activity, interpretations),
        view: freeze({ ...before.value.view, root: result.root }),
      };
      registerAddressIndex(ownership, value.visibility, {
        allocations: before.nodeAllocations,
        visibility: before.nodeVisibility,
        flowHomes: before.flowHomes,
      });
      return { ...before, ...roots, value, commandIndex, interpretationIndex };
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
    return { ...before, value, nodes, commandIndex, interpretationIndex };
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
      const actions = input.actions.map((a) => a.action),
        source = sequence && readySource(sequence);
      const selection = interpretationCandidate(
        this.state,
        actions,
        source,
        activity,
        input.initialProperties,
      );
      const visibility = indexedVisibility(
        this.state,
        actions,
        source,
        this.counts,
        selection.delta?.changes,
      );
      const value = projectWithActivity(input, activity, {
        ...structure.value,
        visibility: visibility.reduce,
        interpretations: selection.index.value(),
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
    destination?: {
      readonly tapes: readonly TapeId[];
      readonly stable?: boolean;
      deleted(node: NodeId): boolean;
    },
    fresh: readonly ActionEnvelope[] = [action],
  ) {
    const text = before.text.fork(),
      coverage = before.subtrees.update(
        changes,
        [],
        [],
        projectedActivity(groupActivity, before.value.interpretations),
        [],
        (marker) => native.marker(marker).index,
      ),
      subtrees = coverage.index,
      deletions = before.deletions.update(
        changes,
        (ref) =>
          groupActivity.isEffectActive(ref) && before.value.interpretations.effectEligible(ref),
        this.counts,
      );
    const affected = new Set<string>(),
      runOwners = new Map<string, NodeId>();
    const ownerNode = (assignment: ReturnType<OwnershipResult['owner']>) => {
      const key = resourceKey(assignment.run);
      let node = runOwners.get(key);
      if (!node) {
        const flow = before.runFlows.get(key);
        if (!flow) throw new Error('Text owner lacks a retained run flow');
        node = ownership.flowBlock(flow);
        runOwners.set(key, node);
      }
      return node;
    };
    const nativeTapes = new Set(touched.map(resourceKey));
    const semanticTapes = new Map(touched.map((tape) => [resourceKey(tape), tape]));
    for (const tape of destination?.tapes ?? []) semanticTapes.set(resourceKey(tape), tape);
    for (const tape of coverage.tapes) semanticTapes.set(resourceKey(tape), tape);
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
    const hasMarkers = fresh.some((a) =>
      a.allocations.some((allocation) => allocation.type === 'marker'),
    );
    for (const [id, tape] of semanticTapes) {
      if (hasMarkers && nativeTapes.has(id))
        for (const node of before.tapeNodes.get(id) ?? []) affected.add(node);
      const old = new Map(text.get(id)?.byId);
      for (const born of fresh)
        for (const birth of born.nativeManifest)
          if (birth.type === 'text' && resourceKey(birth.tape) === id) {
            for (let i = 0; i < birth.native.length; i++) {
              const token = {
                tape,
                native: { client: birth.native.client, clock: birth.native.clock + i },
                birth: born.id,
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
      const newTokens = new Set(
        fresh
          .flatMap((a) => a.nativeManifest)
          .flatMap((birth) =>
            birth.type === 'text' && resourceKey(birth.tape) === id
              ? Array.from({ length: birth.native.length }, (_, i) =>
                  tokenKey({ client: birth.native.client, clock: birth.native.clock + i }),
                )
              : [],
          ),
      );
      for (const [key, entry] of old) {
        if (
          (!destination || destination.stable) &&
          !control &&
          !coverage.tapes.length &&
          !newTokens.has(key) &&
          !newDeletes.some((range) => covers(range, entry))
        )
          continue;
        let assignment: ReturnType<OwnershipResult['owner']> | undefined;
        const cell = () => (assignment ??= ownership.owner(entry.token));
        const matches = [
          ...deletions.declarations(entry.token, this.counts),
          ...subtrees.matches(entry.token, (range, token) => ownership.contains(range, token), {
            gap: () => native.marker(cell().cell.start).index,
            position: (marker) => native.marker(marker).index,
          }),
        ].sort(compareEffects);
        const tags = [...new Map(matches.map(({ tag }) => [resourceKey(tag), tag])).values()];
        const insertionActive =
          entry.token.birth === null || groupActivity.isActive(entry.token.birth);
        const deletedDestination = destination
          ? destination.deleted(ownerNode(cell()))
          : entry.deletedDestination;
        if (
          entry.insertionActive === insertionActive &&
          entry.deletedDestination === deletedDestination &&
          entry.tags.length === tags.length &&
          entry.tags.every((tag, i) => resourceKey(tag) === resourceKey(tags[i]))
        )
          continue;
        old.set(key, {
          ...entry,
          insertionActive,
          tags,
          deletedDestination,
          visible: insertionActive && !tags.length && !deletedDestination,
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
    return { text, deletions, subtrees, affected, tapes: [...semanticTapes.values()] };
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
    const updated = this.updateText(
      before,
      action,
      ownership,
      touched,
      native,
      groupActivity,
      changes,
      control,
      { tapes: [], stable: true, deleted: (node) => before.witnesses.deleted(node) },
    );
    const { text, deletions, subtrees, affected } = updated;
    const visibilityDraft = before.witnesses.prepare({
      nodes: [...affected].map((id) => before.nodeAllocations.get(id)!.id),
      ownership,
      activity: projectedActivity(groupActivity, before.value.interpretations),
      birthEnabled: (node) =>
        before.value.interpretations.birthEnabled(node) && !before.splitVisibility.hidden(node),
      requirements: (node) =>
        (before.nodeRequirements.get(resourceKey(node)) ?? []).filter((ref) =>
          before.splitVisibility.permits(ref),
        ),
      tags: (node) => subtrees.nodeTags(node),
    });
    visibilityDraft.draft.replaceTapes(
      updated.tapes,
      text,
      ownership,
      visibilityDraft.dirty,
      before.runFlows,
      before.text,
    );
    const witnessChanges = visibilityDraft.draft.finish(visibilityDraft.dirty);
    const witnesses = visibilityDraft.draft;
    const changed = new Map<string, ViewNode>();
    const visible = (range: NativeTextRange) =>
      text.get(resourceKey(range.tape))?.byId.get(tokenKey(range))?.visible === true;
    const interpretations = before.value.interpretations;
    if (
      witnessChanges.size ||
      [...affected].some((id) => !before.nodes.has(id) && witnesses.nodes.get(id)?.available)
    ) {
      const root = before.value.view.root;
      const result = projectNormalizationRegion({
        before: {
          root,
          ownership: before.value.ownership,
          dependencies: before.normalization,
          hasNode: (id) => before.nodeAllocations.has(id),
          node: (id) => before.nodes.get(id)?.node,
        },
        ownership,
        interpretations,
        visibility: witnesses.nodes,
        affected: [...new Set([...affected, ...witnessChanges])].map(
          (id) => before.nodeAllocations.get(id)!.id,
        ),
        rootRuns: new Map(),
        flowRoots: before.flowRoots,
        projectInline: (seed, run) =>
          projectInline(seed, ownership, native, interpretations, visible, before.tapeHomes, run),
      });
      const roots = replaceRegionRecords(before, result, ownership),
        commandIndex = before.commandIndex.refine(result.root);
      registerCommandViewIndex(result.root, commandIndex);
      const visibility = resourceVisibility(before.order, text, witnesses.nodes);
      const value: Projection = {
        ownership,
        interpretations,
        activity: projectedActivity(groupActivity, interpretations),
        visibility,
        view: freeze({
          root: result.root,
          emptyRoot: roots.inlineCount
            ? null
            : {
                type: 'empty-root' as const,
                slot: { parent: root.origin.representative, predecessor: null },
              },
        }),
      };
      registerAddressIndex(ownership, visibility, {
        allocations: before.nodeAllocations,
        visibility: witnesses.nodes,
        flowHomes: before.flowHomes,
      });
      return {
        ...before,
        ...roots,
        value,
        nodeVisibility: witnesses.nodes,
        text,
        deletions,
        subtrees,
        witnesses,
        commandIndex,
      };
    }
    for (const id of affected) {
      const record = before.nodes.get(id);
      if (!record && !witnesses.nodes.get(id)?.available) continue;
      if (!record) throw new Error('Missing available text projection');
      changed.set(
        id,
        projectInline(
          record.node,
          ownership,
          native,
          before.value.interpretations,
          visible,
          before.tapeHomes,
          before.flowRoots.get(resourceKey(before.nodeAllocations.get(id)!.flow!)),
        ),
      );
    }
    const { nodes, commandIndex, replaced } = replaceViews(before, changed);
    this.counts.projectionRecordsReplaced += replaced;
    const value: Projection = {
      view: Object.freeze({
        root: nodes.get(key(before.value.view.root))!.node,
        emptyRoot: before.value.view.emptyRoot,
      }),
      ownership,
      activity: projectedActivity(groupActivity, interpretations),
      interpretations,
      visibility: resourceVisibility(before.order, text, witnesses.nodes),
    };
    registerAddressIndex(ownership, value.visibility, {
      allocations: before.nodeAllocations,
      visibility: witnesses.nodes,
      flowHomes: before.flowHomes,
    });
    return {
      ...before,
      value,
      nodes,
      text,
      deletions,
      subtrees,
      witnesses,
      nodeVisibility: witnesses.nodes,
      commandIndex,
    };
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
