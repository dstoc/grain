import { countWork, measureWork } from '../diagnostics.js';
import { measure } from '../diagnostics.js';
import type { ReadySequence } from '../authoring/ready-source.js';
import type {
  ActionEnvelope,
  NativeTextRange,
  TapeId,
  DeletionId,
  ActionId,
} from '../contracts.js';
import type { NativeView } from '../ingest/publication.js';
import type { ActionSequence, PayloadIndex } from './activity.js';
import type { Activity } from '../visibility/activity.js';
import type { TextVisibility } from '../visibility/visibility.js';
import type { ProjectionInput } from '../projection/project.js';
import { projectWithActivity } from '../projection/project.js';
import type { TextBoundary, TextFragment, ViewNode } from '../projection/types.js';
import { textOrigin } from '../projection/types.js';
import { resourceKey } from '../layout/index.js';
import type { OwnershipResult } from '../ownership/ownership.js';
import { reconstructProvenance } from '../reference/provenance.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { commandViewIndex, registerCommandViewIndex } from '../authoring/view-index.js';
import type { CommandViewIndex } from '../authoring/view-index.js';
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

type Projection = ReturnType<typeof projectWithActivity>;
/** No query or activity callback escapes into a publication/checkpoint. */
function indexedVisibility(work: TextDeletionWork): typeof reduceVisibility {
  return (activity, layout, tokens, birthEnabled = () => true) => {
    const index = new ExactTextDeletions(activity, work);
    return reduceVisibilityWithTextTags(activity, layout, tokens, birthEnabled, (token) =>
      index.matches(token),
    );
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
interface TextDeletion {
  readonly action: ActionId;
  readonly ordinal: number;
  readonly tag: DeletionId;
  readonly ranges: readonly NativeTextRange[];
}
interface State {
  readonly value: Projection;
  readonly nodes: PersistentMap<NodeRecord>;
  readonly text: PersistentMap<TextTape>;
  readonly deletions: PersistentMap<readonly TextDeletion[]>;
  readonly tapeNodes: PersistentMap<readonly string[]>;
  readonly tapes: readonly TapeId[];
  readonly stableVisibility: boolean;
  readonly commandIndex: CommandViewIndex;
  readonly commandOrigins: PersistentMap<ViewNode>;
  readonly propertyBase: Projection['interpretations'];
  readonly properties: PersistentMap<PresentedProperties>;
}
const key = (node: ViewNode) => resourceKey(node.origin.representative);
const tokenKey = (range: { readonly client: number; readonly clock: number }) =>
  `${range.client}:${range.clock}`;
/** Retain exact deletion declarations, including inactive ones, in semantic order. */
function recordDeletions(index: State['deletions'], action: ActionEnvelope): void {
  for (const [ordinal, effect] of action.effects.entries()) {
    if (effect.type !== 'DeleteText') continue;
    const tapes = new Set(effect.observed.map((range) => resourceKey(range.tape)));
    for (const tape of tapes)
      index.set(tape, [
        ...(index.get(tape) ?? []),
        {
          action: action.id,
          ordinal,
          tag: effect.tag,
          ranges: effect.observed.filter((range) => resourceKey(range.tape) === tape),
        },
      ]);
  }
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
  tapes: readonly TapeId[],
  text: State['text'],
  nodes: Projection['visibility']['nodes'],
): Projection['visibility'] {
  let allText: readonly TextVisibility[] | undefined;
  return {
    get text() {
      return (allText ??= tapes.flatMap((tape) => text.get(resourceKey(tape))?.entries ?? []));
    },
    nodes,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function index(value: Projection, input: ProjectionInput): State {
  return measure('visibility-normalization', () => indexMeasured(value, input));
}
function indexMeasured(value: Projection, input: ProjectionInput): State {
  const nodes = new PersistentMap<NodeRecord>(),
    text = new PersistentMap<TextTape>(),
    deletions = new PersistentMap<readonly TextDeletion[]>(),
    tapeNodes = new PersistentMap<readonly string[]>();
  countWork('projection.fullIndexesConstructed');
  const visit = (node: ViewNode, depth: number, parent?: string) => {
    countWork('projection.viewRecordsIndexed');
    nodes.set(key(node), { node, depth, parent });
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
  for (const { action } of input.actions) recordDeletions(deletions, action);
  const sourceIndex = commandViewIndex(value.view.root);
  const commandOrigins = new PersistentMap<ViewNode>();
  for (const [id, node] of sourceIndex.origins) commandOrigins.set(id, node);
  const commandIndex = { ...sourceIndex, origins: commandOrigins };
  registerCommandViewIndex(value.view.root, commandIndex);
  return {
    value,
    nodes,
    text,
    deletions,
    tapeNodes,
    commandIndex,
    commandOrigins,
    propertyBase: value.interpretations,
    properties: new PersistentMap<PresentedProperties>(),
    tapes: [
      ...input.genesis.allocations,
      ...input.actions.flatMap(({ action }) => action.allocations),
    ].flatMap((a) => (a.type === 'tape' ? [a.id] : [])),
    stableVisibility:
      value.visibility.nodes.every(
        (n) => n.available && !n.deleted && !n.suppressed && !n.scaffold,
      ) && !value.activity.effects.some(({ effect }) => effect.type === 'DeleteSubtree'),
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
): ViewNode {
  const allocation = before.origin.representative;
  // A rendered inline is the home of the effective top-level flow. Its boundary
  // records supply the persistent run; no complete allocation/run scan is needed.
  const rootRun = before.boundaries[0]?.address.slot.run;
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
        const home = ownership.homeForTape(marker.tape);
        if (!home) throw new Error('Text slot lacks a retained private home');
        end = native.marker(home.cell.end).index;
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

function replaceViews(before: State, changed: Map<string, ViewNode>) {
  const nodes = before.nodes.fork();
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
  const commandOrigins = before.commandOrigins.fork();
  for (const node of changed.values()) commandOrigins.set(before.commandIndex.handle(node)!, node);
  const commandIndex = { ...before.commandIndex, origins: commandOrigins };
  registerCommandViewIndex(nodes.get(key(before.value.view.root))!.node, commandIndex);
  return { nodes, commandOrigins, commandIndex, replaced };
}

/** Local projection covers text and checked/info changes on active nodes.
 * Subtree deletion, inactive births, scaffolds and structural/interpretation
 * changes use the coupled/full fallback.
 */
export class MaterializedProjection {
  private readonly ownership = new MaterializedOwnership();
  private state?: State;
  private generation = 0;
  private readonly counts = {
    fullProjections: 0,
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
    const suffix = before?.stableVisibility
      ? this.ownership.prepareText(actions, native, activity, variants)
      : undefined;
    const properties =
      !suffix && before?.stableVisibility
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
      const value = projectWithActivity(input, activity, {
        ...prepared.value,
        visibility: indexedVisibility(this.counts),
      });
      state = index(value, input);
      commitStructure = prepared.commit;
      this.counts.fullProjections++;
    }
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
  canStageText(action: ActionEnvelope): boolean {
    return this.state?.stableVisibility === true && isTextRefinement(action);
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
    return this.state?.stableVisibility === true && isPropertyRefinement(action);
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
    const propertyBase = control ? selectInterpretations(activity, initial) : before.propertyBase,
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
    const { nodes, commandOrigins, commandIndex, replaced } = replaceViews(before, changed);
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
    return { ...before, value, nodes, commandOrigins, commandIndex, propertyBase, properties };
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
      const value = projectWithActivity(input, activity, {
        ...structure.value,
        visibility: indexedVisibility(this.counts),
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
    const text = before.text.fork(),
      deletions = before.deletions.fork(),
      changed = new Map<string, ViewNode>();
    recordDeletions(deletions, action);
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
      const activeDeletes =
        newDeletes.length || control
          ? (deletions.get(id) ?? []).filter(
              (deletion) =>
                groupActivity.isEffectActive(deletion) &&
                before.value.interpretations.effectEligible(deletion),
            )
          : [];
      for (const [key, entry] of old) {
        if (!control && !newDeletes.some((range) => covers(range, entry))) continue;
        const tags = new Map<string, DeletionId>();
        for (const deletion of activeDeletes)
          if (deletion.ranges.some((range) => covers(range, entry)))
            tags.set(resourceKey(deletion.tag), deletion.tag);
        const insertionActive =
          control && entry.token.birth !== null
            ? groupActivity.isActive(entry.token.birth)
            : entry.insertionActive;
        if (
          entry.insertionActive === insertionActive &&
          entry.tags.length === tags.size &&
          entry.tags.every((tag, i) => resourceKey(tag) === [...tags.keys()][i])
        )
          continue;
        old.set(key, {
          ...entry,
          insertionActive,
          tags: [...tags.values()],
          visible: insertionActive && !tags.size,
        });
      }
      const home = nativeTapes.has(id) && ownership.homeForTape(tape);
      if (nativeTapes.has(id) && !home)
        throw new Error('Text change lacks a retained private home');
      // Ordering still visits retained text on the affected tape. Read its open
      // home interval without exporting/cloning a complete marker snapshot.
      const entries = home
        ? native.range(home.cell).flatMap((part) =>
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
    const visible = (range: NativeTextRange) =>
      text.get(resourceKey(range.tape))?.byId.get(tokenKey(range))?.visible === true;
    for (const id of affected) {
      const record = before.nodes.get(id);
      if (!record) throw new Error('Text change changed an unavailable projected owner');
      changed.set(
        id,
        projectInline(record.node, ownership, native, before.value.interpretations, visible),
      );
    }
    const { nodes, commandIndex, commandOrigins, replaced } = replaceViews(before, changed);
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
    return { ...before, value, nodes, text, deletions, commandIndex, commandOrigins };
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
