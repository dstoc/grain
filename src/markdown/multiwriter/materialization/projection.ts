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

type Projection = ReturnType<typeof projectWithActivity>;
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
  readonly canAppendText: boolean;
  readonly commandIndex: CommandViewIndex;
  readonly commandOrigins: PersistentMap<ViewNode>;
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
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function index(value: Projection, input: ProjectionInput): State {
  const nodes = new PersistentMap<NodeRecord>(),
    text = new PersistentMap<TextTape>(),
    deletions = new PersistentMap<readonly TextDeletion[]>(),
    tapeNodes = new PersistentMap<readonly string[]>();
  const visit = (node: ViewNode, depth: number, parent?: string) => {
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
    tapes: [
      ...input.genesis.allocations,
      ...input.actions.flatMap(({ action }) => action.allocations),
    ].flatMap((a) => (a.type === 'tape' ? [a.id] : [])),
    canAppendText:
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
  const flow = ownership.runLayout(rootRun).flow;
  if (resourceKey(ownership.flowBlock(flow)) !== resourceKey(allocation))
    throw new Error('Inline owner changed during text append');
  let content = '';
  const boundaries: TextBoundary[] = [],
    fragments: TextFragment[] = [];
  const tapes = new Map<string, ReturnType<NativeView['snapshot']>>();
  const addresses = new Map(before.boundaries.map((b) => [addressKey(b.address), b.address]));
  for (const fragment of before.fragments)
    addresses.set(addressKey(fragment.address), fragment.address);
  const address = (value: ReturnType<typeof textOrigin>) =>
    addresses.get(addressKey(value)) ?? freeze(value);
  for (const entry of ownership.raw(flow)) {
    if (entry.type === 'slot') {
      const marker = native.marker(entry.slot.boundary),
        id = resourceKey(marker.tape);
      let snapshot = tapes.get(id);
      if (!snapshot) {
        snapshot = native.snapshot(marker.tape);
        tapes.set(id, snapshot);
      }
      if (
        (marker.index === 0 && entry.slot.side === 'left') ||
        (marker.index === snapshot.length - 1 && entry.slot.side === 'right')
      )
        continue;
      const origin = ownership
        .runLayout(entry.slot.run)
        .skeleton.find((range) => ownership.containsBoundary(range, entry.slot.boundary));
      if (!origin) throw new Error('Text slot lacks a retained origin');
      boundaries.push(
        Object.freeze({ offset: content.length, address: address(textOrigin(entry.slot, origin)) }),
      );
    } else if (entry.type === 'cell')
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
          const text = native
            .lookup(range)
            .map((part) => part.text)
            .join('');
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
          fragments.push(
            freeze({ text, range, address: location, visible: shown && !mask, masked: mask }),
          );
          if (shown && !mask) content += text;
          start = end;
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

/** Local text projection covers insertions and exact deletion on active nodes.
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
  };
  fullProjectionCount(): number {
    return this.counts.fullProjections;
  }
  diagnostics() {
    return { ...this.counts, ownership: this.ownership.diagnostics() };
  }
  *prepare(
    genesis: ReferenceGenesis,
    actions: readonly ActionEnvelope[],
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
  ) {
    const generation = ++this.generation,
      before = this.state;
    const suffix = before?.canAppendText
      ? this.ownership.prepareText(actions, native, activity, variants)
      : undefined;
    let state: State, commitStructure: () => void;
    if (suffix && before) {
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
        ...reconstructProvenance(genesis.layout, actions),
        native,
      };
      const prepared = yield* this.ownership.prepare(input, activity, variants);
      yield;
      const value = projectWithActivity(input, activity, prepared.value);
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
    return this.state?.canAppendText === true && isTextRefinement(action);
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
    const text = before.text.fork(),
      deletions = before.deletions.fork(),
      nodes = before.nodes.fork(),
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
      const entries = nativeTapes.has(id)
        ? native.snapshot(tape).parts.flatMap((part) =>
            part.type === 'text'
              ? Array.from({ length: part.text.length }, (_, i) => {
                  const entry = old.get(
                    tokenKey({ client: part.native.client, clock: part.native.clock + i }),
                  );
                  if (!entry)
                    throw new Error('Text change contains an uncertified native identity');
                  return entry;
                })
              : [],
          )
        : (text.get(id)?.entries ?? []).map((entry) => old.get(tokenKey(entry.token.native))!);
      text.set(id, { entries, byId: old });
      this.counts.textTapesRebuilt++;
    }
    const visible = (range: NativeTextRange) =>
      text.get(resourceKey(range.tape))?.byId.get(tokenKey(range))?.visible === true;
    for (const id of affected) {
      const record = nodes.get(id);
      if (!record) throw new Error('Text change changed an unavailable projected owner');
      changed.set(
        id,
        projectInline(record.node, ownership, native, before.value.interpretations, visible),
      );
    }
    const pending = new Set(changed.keys());
    while (pending.size) {
      const id = [...pending].sort((a, b) => nodes.get(b)!.depth - nodes.get(a)!.depth)[0];
      pending.delete(id);
      const record = nodes.get(id)!,
        value = changed.get(id)!;
      nodes.set(id, { ...record, node: value });
      this.counts.projectionRecordsReplaced++;
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
    const interpretations = before.value.interpretations;
    const effectActive = (ref: Parameters<Activity['isEffectActive']>[0]) =>
      groupActivity.isEffectActive(ref) && interpretations.effectEligible(ref);
    const activity = {
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
    let allText: readonly TextVisibility[] | undefined;
    const value: Projection = {
      view: Object.freeze({
        root: nodes.get(key(before.value.view.root))!.node,
        emptyRoot: before.value.view.emptyRoot,
      }),
      ownership,
      activity,
      interpretations,
      visibility: {
        get text() {
          return (allText ??= before.tapes.flatMap(
            (tape) => text.get(resourceKey(tape))?.entries ?? [],
          ));
        },
        nodes: before.value.visibility.nodes,
      },
    };
    const commandOrigins = before.commandOrigins.fork();
    for (const node of changed.values())
      commandOrigins.set(before.commandIndex.handle(node)!, node);
    const commandIndex = { ...before.commandIndex, origins: commandOrigins };
    registerCommandViewIndex(value.view.root, commandIndex);
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
