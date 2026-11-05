import type { ActionEnvelope, NativeTextRange, TapeId } from '../contracts.js';
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
interface State {
  readonly value: Projection;
  readonly nodes: PersistentMap<NodeRecord>;
  readonly text: PersistentMap<readonly TextVisibility[]>;
  readonly tapeNodes: PersistentMap<readonly string[]>;
  readonly tapes: readonly TapeId[];
  readonly canAppendText: boolean;
  readonly commandIndex: CommandViewIndex;
  readonly commandOrigins: PersistentMap<ViewNode>;
}
const key = (node: ViewNode) => resourceKey(node.origin.representative);
const tokenKey = (range: { readonly client: number; readonly clock: number }) =>
  `${range.client}:${range.clock}`;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function index(value: Projection, input: ProjectionInput): State {
  const nodes = new PersistentMap<NodeRecord>(),
    text = new PersistentMap<readonly TextVisibility[]>(),
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
  for (const [id, list] of entries) text.set(id, list);
  const sourceIndex = commandViewIndex(value.view.root);
  const commandOrigins = new PersistentMap<ViewNode>();
  for (const [id, node] of sourceIndex.origins) commandOrigins.set(id, node);
  const commandIndex = { ...sourceIndex, origins: commandOrigins };
  registerCommandViewIndex(value.view.root, commandIndex);
  return {
    value,
    nodes,
    text,
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
      ) &&
      value.visibility.text.every(
        (t) => t.insertionActive && !t.tags.length && !t.deletedDestination,
      ) &&
      !value.activity.effects.some(
        ({ effect }) => effect.type === 'DeleteText' || effect.type === 'DeleteSubtree',
      ),
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
          const mask = masked(start);
          let end = start + 1;
          while (end < fragment.text.length && masked(end) === mask) end++;
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
          fragments.push(freeze({ text, range, address: location, visible: !mask, masked: mask }));
          if (!mask) content += text;
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

/** Local text projection is deliberately narrow. Deletions, inactive births,
 * scaffolds and structural/interpretation changes use the coupled/full fallback.
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
      state = this.append(before, actions.at(-1)!, suffix.value, suffix.touched, native, activity);
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
  ): State {
    const text = before.text.fork(),
      nodes = before.nodes.fork(),
      changed = new Map<string, ViewNode>();
    const affected = new Set<string>();
    for (const tape of touched) {
      if (action.allocations.length)
        for (const id of before.tapeNodes.get(resourceKey(tape)) ?? []) affected.add(id);
      const id = resourceKey(tape),
        old = new Map((text.get(id) ?? []).map((entry) => [tokenKey(entry.token.native), entry]));
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
          for (const owner of ownership.tokenOwners({ tape, ...birth.native }))
            affected.add(resourceKey(ownership.flowBlock(ownership.runLayout(owner.run).flow)));
        }
      const entries = native.snapshot(tape).parts.flatMap((part) =>
        part.type === 'text'
          ? Array.from({ length: part.text.length }, (_, i) => {
              const entry = old.get(
                tokenKey({ client: part.native.client, clock: part.native.clock + i }),
              );
              if (!entry) throw new Error('Text append contains an uncertified native identity');
              return entry;
            })
          : [],
      );
      text.set(id, entries);
      this.counts.textTapesRebuilt++;
    }
    for (const id of affected) {
      const record = nodes.get(id);
      if (!record) throw new Error('Text append changed an unavailable projected owner');
      changed.set(id, projectInline(record.node, ownership, native, before.value.interpretations));
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
          return (allText ??= before.tapes.flatMap((tape) => text.get(resourceKey(tape)) ?? []));
        },
        nodes: before.value.visibility.nodes,
      },
    };
    const commandOrigins = before.commandOrigins.fork();
    for (const node of changed.values())
      commandOrigins.set(before.commandIndex.handle(node)!, node);
    const commandIndex = { ...before.commandIndex, origins: commandOrigins };
    registerCommandViewIndex(value.view.root, commandIndex);
    return { ...before, value, nodes, text, commandIndex, commandOrigins };
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
