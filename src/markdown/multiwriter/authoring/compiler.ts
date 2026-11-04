import { prepareParserConversion, bindParserConversion } from '../projection/parser-plan.js';
import type { OutputBinding } from '../projection/parser-plan.js';
import type { ParserConversionPlan } from '../../block-parser/types.js';
import { ProjectionError } from '../projection/interpretation.js';
import { isInlineNode } from '../../node.js';
import type { MarkdownNode } from '../../node.js';
import { ConstructionTree } from '../../semantic/construction-tree.js';
import type {
  CreateNodeSpec,
  NodeId as Handle,
  TextAffinity,
  TextEdit,
} from '../../semantic/types.js';
import type { InlineFragment } from '../../semantic/draft.js';
import type { ChildLift, InlineSplit } from '../../../editing/command-draft.js';
import type {
  ActionEnvelope,
  Allocation,
  BlockSlot,
  FlowId,
  InlineSlot,
  NativeTextRange,
  NodeId,
  OccurrenceId,
  RangeRef,
  ResourceId,
  ResourceKind,
  SemanticEffect,
} from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { CellIndex, HomeIndex } from '../ownership/index.js';
import type { OwnershipResult } from '../ownership/index.js';
import type { NativeView } from '../ingest/publication.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { reconstructProvenance } from '../reference/provenance.js';
import { projectMarkdown, projectionDocument } from '../projection/project.js';
import type { SourceFragment } from '../projection/parser-plan.js';
import type { ViewNode } from '../projection/types.js';
import { NativePlan } from './native-plan.js';
import type { MultiwriterCommandDraft } from './draft.js';

function slice(pieces: readonly SourceFragment[], from: number, to: number): SourceFragment[] {
  let at = 0;
  return pieces.flatMap((p) => {
    const a = Math.max(from, at),
      b = Math.min(to, at + p.text.length);
    const start = at;
    at += p.text.length;
    return a < b
      ? [
          {
            text: p.text.slice(a - start, b - start),
            range: { ...p.range, clock: p.range.clock + a - start, length: b - a },
          },
        ]
      : [];
  });
}
const same = (a: ResourceId<ResourceKind>, b: ResourceId<ResourceKind>) =>
  resourceKey(a) === resourceKey(b);

export class ConversionDeclined extends Error {
  constructor(
    readonly reason: 'unsupported-conversion' | 'invalid-conversion',
    message: string,
  ) {
    super(message);
    this.name = 'ConversionDeclined';
  }
}

/** Reference compiler. Commands retain their meaning; only this layer binds schema-3 resources. */
export class CommandCompiler {
  readonly native: NativePlan;
  readonly allocations: Allocation[] = [];
  readonly effects: SemanticEffect[] = [];
  private ordinal = 0;
  private memo?: { key: string; value: ReturnType<typeof projectMarkdown> };
  private readonly ids = new Map<Handle, NodeId>();
  private readonly text = new Map<Handle, readonly SourceFragment[]>();
  private readonly specs = new Map<Handle, CreateNodeSpec>();
  private readonly firstPlaces = new Map<Handle, { parent: Handle; before: Handle | null }>();
  private readonly splitNodes = new Set<Handle>();
  private readonly fragments = new Map<
    InlineFragment,
    { ranges: readonly RangeRef[]; pieces: readonly SourceFragment[] }
  >();
  private readonly seenPlacements = new Set<Handle>();
  private readonly births = new Map<Handle, OccurrenceId>();
  private readonly tree: ConstructionTree;
  constructor(
    readonly genesis: ReferenceGenesis,
    readonly ready: readonly ActionEnvelope[],
    readonly base: Omit<
      ActionEnvelope,
      'allocations' | 'nativeInsertUpdates' | 'nativeManifest' | 'effects'
    >,
    readonly draft: MultiwriterCommandDraft,
    root: ViewNode,
    native: NativeView,
  ) {
    this.native = new NativePlan(
      [...genesis.layout.allocations, ...ready.flatMap((a) => a.allocations)]
        .filter((a) => a.type === 'tape')
        .map((t) => native.snapshot(t.id)),
    );
    this.tree = new ConstructionTree(projectionDocument({ root, emptyRoot: null }));
    for (const [handle, view] of draft.origins) {
      this.ids.set(handle, view.origin.representative);
      this.text.set(
        handle,
        view.fragments.filter((p) => p.visible).map((p) => ({ text: p.text, range: p.range })),
      );
    }
    for (const intent of draft.intents) {
      if (intent.type === 'create') this.specs.set(intent.id, intent.spec);
      if (intent.type === 'place' && !this.firstPlaces.has(intent.id))
        this.firstPlaces.set(intent.id, intent);
      if (intent.type === 'split') this.splitNodes.add(intent.split.destination);
    }
  }
  private alloc<K extends ResourceKind>(kind: K): ResourceId<K> {
    if (this.ordinal >= 0xffffffff) throw new Error('Action resource ordinal overflow');
    return { kind, birth: { type: 'action', action: this.base.id }, ordinal: this.ordinal++ };
  }
  envelope(): ActionEnvelope {
    return {
      ...this.base,
      allocations: [...this.allocations, ...this.native.allocations],
      nativeManifest: [...this.native.manifest],
      nativeInsertUpdates: [],
      effects: [...this.effects],
    };
  }
  private state() {
    const key = `${this.allocations.length}:${this.effects.length}:${this.native.operations.length}`;
    if (this.memo?.key === key) return this.memo.value;
    const actions = [...this.ready, this.envelope()];
    const value = projectMarkdown({
      genesis: this.genesis.layout,
      genesisManifest: this.genesis.body.nativeManifest,
      initialProperties: this.genesis.initialProperties,
      ...reconstructProvenance(this.genesis.layout, actions),
      native: this.native,
    });
    this.memo = { key, value };
    return value;
  }
  private ownership(): OwnershipResult {
    return this.state().ownership;
  }
  private id(handle: Handle): NodeId {
    const id = this.ids.get(handle);
    if (id) return id;
    if (this.splitNodes.has(handle)) throw new Error('Split destination is not yet constructed');
    const spec = this.specs.get(handle),
      place = this.firstPlaces.get(handle);
    if (!spec || !place) throw new Error('Detached allocation has no authored placement');
    const slot = this.blockSlot(place.parent, place.before, handle);
    return this.create(handle, spec, slot);
  }
  private create(
    handle: Handle,
    spec: CreateNodeSpec,
    slot: BlockSlot,
    captured: readonly RangeRef[] = [],
    split?: {
      basis: Extract<SemanticEffect, { type: 'SplitFlow' }>['basis'];
      cut: InlineSlot;
      retainedSide: 'left' | 'right';
    },
  ) {
    const node = this.alloc('node'),
      occurrence = this.alloc('occurrence');
    const inline =
      spec.type === 'paragraph' || spec.type === 'section' || spec.type === 'code-block';
    const flow = inline ? this.alloc('flow') : null;
    const role = inline ? 'inline' : spec.type === 'block-quote' ? 'quote' : spec.type;
    this.ids.set(handle, node);
    this.births.set(handle, occurrence);
    const needsPlacement =
      !split &&
      slot.predecessor !== null &&
      this.effects.some(
        (e) =>
          ((e.type === 'MoveBlock' ||
            e.type === 'JoinFlow' ||
            e.type === 'TransferRange' ||
            e.type === 'SplitFlow') &&
            same(e.occurrence, slot.predecessor!)) ||
          (e.type === 'LiftChildren' &&
            e.placements.some((p) => same(p.occurrence, slot.predecessor!))),
      );
    let birthSlot = slot;
    if (needsPlacement) {
      const used = new Set(
        this.effects.flatMap((e) =>
          e.type === 'MoveBlock' ||
          e.type === 'JoinFlow' ||
          e.type === 'TransferRange' ||
          e.type === 'SplitFlow'
            ? [resourceKey(e.occurrence)]
            : e.type === 'LiftChildren'
              ? e.placements.map((p) => resourceKey(p.occurrence))
              : [],
        ),
      );
      const earlier = this.allocations.findLast(
        (a) =>
          a.type === 'occurrence' &&
          'parent' in a.slot &&
          same(a.slot.parent, slot.parent) &&
          !used.has(resourceKey(a.id)),
      );
      birthSlot = {
        parent: slot.parent,
        predecessor: earlier?.type === 'occurrence' ? earlier.id : null,
      };
    }
    this.allocations.push(
      { type: 'node', id: node, role, flow, birthSlot },
      { type: 'occurrence', id: occurrence, slot: birthSlot },
    );
    if (flow) {
      const run = this.alloc('run'),
        tape = this.alloc('tape'),
        start = this.alloc('marker'),
        end = this.alloc('marker');
      this.native.add({ type: 'createTape', tape, start, end });
      this.allocations.push(
        { type: 'flow', id: flow, home: node },
        { type: 'run', id: run, flow, skeleton: [...captured, { tape, start, end }] },
      );
      if (split)
        this.effects.push({
          type: 'SplitFlow',
          ...split,
          newNode: node,
          newFlow: flow,
          newRun: run,
          occurrence,
          outerSlot: slot,
        });
    }
    const values = {
      presentation:
        spec.type === 'section'
          ? ('section' as const)
          : spec.type === 'code-block'
            ? ('code' as const)
            : ('paragraph' as const),
      marker:
        'marker' in spec
          ? (spec.marker ??
            (spec.type === 'section' ? '#' : spec.type === 'list-item' ? '- ' : '> '))
          : null,
      info: spec.type === 'code-block' ? (spec.info ?? null) : null,
      ...(spec.type === 'list-item' ? { checked: spec.checked ?? null } : {}),
    };
    this.effects.push({ type: 'SetProperties', node, values });
    this.text.set(handle, []);
    if ('content' in spec && spec.content) this.insert(handle, 0, spec.content, 'right');
    if (needsPlacement) {
      const placement = this.alloc('occurrence');
      this.allocations.push({ type: 'occurrence', id: placement, slot });
      this.effects.push({
        type: 'MoveBlock',
        node,
        occurrence: placement,
        slot,
        standaloneFlow: flow,
      });
    }
    return node;
  }
  private flow(handle: Handle): FlowId {
    const id = this.id(handle),
      flow = this.ownership().nodeAllocations.find((n) => same(n.id, id))?.flow;
    if (!flow) throw new Error('Command target has no inline flow');
    return flow;
  }
  private blockSlot(parent: Handle, before: Handle | null, moving?: Handle): BlockSlot {
    const parentId = this.id(parent);
    const children = this.tree.draft.node(parent).children.filter((id) => id !== moving);
    const at = before === null ? children.length : children.indexOf(before);
    if (at < 0) throw new Error('Insertion reference is not a destination child');
    const view = this.draft.origins.get(parent);
    // A merged wrapper's original boundaries decide its raw insertion container.
    if (view && view.wrappers.length > 1) {
      if (before !== null) {
        const target = this.draft.origins.get(before);
        if (!target?.edge) throw new Error('Ambiguous normalized wrapper insertion');
        return structuredClone(target.edge.slot);
      }
      return structuredClone(view.wrappers.at(-1)!.end);
    }
    const previous = at > 0 ? children[at - 1] : undefined;
    const predecessor = previous
      ? (this.ownership().blockPlacement(this.id(previous))?.occurrence ??
        this.births.get(previous) ??
        null)
      : null;
    return { parent: parentId, predecessor };
  }
  private pieces(handle: Handle) {
    return this.text.get(handle) ?? [];
  }
  private length(handle: Handle) {
    return this.pieces(handle).reduce((n, p) => n + p.text.length, 0);
  }
  private replace(handle: Handle, from: number, to: number, p: readonly SourceFragment[]) {
    const old = this.pieces(handle);
    this.text.set(handle, [...slice(old, 0, from), ...p, ...slice(old, to, Infinity)]);
  }
  private point(
    handle: Handle,
    offset: number,
    affinity: TextAffinity,
  ): { tape: RangeRef['tape']; index: number; slot: InlineSlot } {
    const ownership = this.ownership(),
      pieces = this.pieces(handle);
    let at = 0;
    const entries = pieces.map((p) => {
      const start = at;
      at += p.text.length;
      return { p, start, end: at };
    });
    const left = entries.findLast((e) => e.start < offset && offset <= e.end),
      right = entries.find((e) => e.start <= offset && offset < e.end);
    const candidate = affinity === 'left' ? (left ?? right) : (right ?? left);
    if (candidate) {
      const { p, start } = candidate,
        local = offset - start;
      // Native coordinate arithmetic refers to the exact retained fragment, not a string search.
      let scalar = local;
      let after = 0;
      if (local === p.text.length) {
        scalar = local - 1;
        if (scalar > 0 && /[\uDC00-\uDFFF]/.test(p.text[scalar]!)) scalar--;
        after = local - scalar;
      }
      const neighbor = { client: p.range.client, clock: p.range.clock + scalar };
      const index = this.native.locate(p.range.tape, neighbor) + after;
      const owner = ownership.owner({ tape: p.range.tape, native: neighbor });
      return {
        tape: p.range.tape,
        index,
        slot: {
          run: owner.run,
          boundary: local === 0 ? owner.cell.start : owner.cell.end,
          side: local === 0 ? 'right' : 'left',
          predecessor: null,
        },
      };
    }
    const flow = this.flow(handle),
      home = ownership.homeBindings.find((h) =>
        ownership.runLayouts.some((r) => same(r.run, h.run) && same(r.flow, flow)),
      );
    if (!home) throw new Error('Empty inline has no retained home');
    return {
      tape: home.cell.tape,
      index: this.native.marker(home.cell.end).index,
      slot: { run: home.run, boundary: home.cell.end, side: 'left', predecessor: null },
    };
  }
  private insert(handle: Handle, offset: number, text: string, affinity: TextAffinity) {
    if (!text.length) return;
    this.id(handle);
    const point = this.point(handle, offset, affinity),
      index = new CellIndex(this.native.all()),
      ownership = this.ownership();
    const neighbor = index.adjacent(point.slot.boundary, point.slot.side);
    let ranges: readonly NativeTextRange[] = [];
    if (new HomeIndex(ownership.homeBindings, index).isReserved(neighbor.range)) {
      for (const op of new HomeIndex(ownership.homeBindings, index).planTextInsertion(
        point.slot,
        text,
        () => this.alloc('marker'),
      ))
        ranges = [...ranges, ...this.native.add(op)];
    } else ranges = this.native.add({ type: 'text', tape: point.tape, index: point.index, text });
    this.effects.push({ type: 'InsertText', ranges });
    this.replace(
      handle,
      offset,
      offset,
      ranges.flatMap((range) =>
        this.native.lookup(range).map((p) => ({ text: p.text, range: p.range })),
      ),
    );
  }
  private deleteText(handle: Handle, from: number, to: number) {
    const selected = slice(this.pieces(handle), from, to).map((p) => p.range);
    if (selected.length) {
      const tag = this.alloc('deletion');
      this.allocations.push({ type: 'deletion', id: tag });
      this.effects.push({ type: 'DeleteText', tag, observed: selected });
    }
    this.replace(handle, from, to, []);
  }
  private splice(handle: Handle, edit: TextEdit) {
    this.id(handle);
    this.deleteText(handle, edit.from, edit.to);
    this.insert(handle, edit.from, edit.insert, edit.affinity ?? 'right');
  }
  private boundary(handle: Handle, offset: number, affinity: TextAffinity): InlineSlot {
    const p = this.point(handle, offset, affinity),
      boundary = this.alloc('marker');
    this.native.add({ type: 'marker', tape: p.tape, index: p.index, marker: boundary, affinity });
    return { ...p.slot, boundary, side: 'right', predecessor: null };
  }
  private split(split: InlineSplit) {
    const { source, destination, from, to, retainedSide } = split;
    this.id(source);
    const original = this.pieces(source),
      flow = this.flow(source);
    let ownership = this.ownership(),
      homes = new HomeIndex(ownership.homeBindings, new CellIndex(this.native.all()));
    let basis = ownership
      .raw(flow)
      .flatMap((e) =>
        e.type === 'cell' && !homes.isReserved(e.assignment.cell)
          ? [{ range: e.assignment.cell, occurrence: e.assignment.occurrence }]
          : [],
      );
    const ownHome = ownership.homeBindings.find((h) =>
      ownership.runLayouts.some((r) => same(r.run, h.run) && same(r.flow, flow)),
    )!;
    let cut: InlineSlot;
    if (!basis.length)
      cut = { run: ownHome.run, boundary: ownHome.cell.end, side: 'left', predecessor: null };
    else {
      cut = this.boundary(source, from, 'right');
      ownership = this.ownership();
      homes = new HomeIndex(ownership.homeBindings, new CellIndex(this.native.all()));
      basis = ownership
        .raw(flow)
        .flatMap((e) =>
          e.type === 'cell' && !homes.isReserved(e.assignment.cell)
            ? [{ range: e.assignment.cell, occurrence: e.assignment.occurrence }]
            : [],
        );
    }
    this.deleteText(source, from, to);
    const positions = new Set<number>();
    basis.forEach((b, i) => {
      if (same(b.range.start, cut.boundary)) positions.add(i);
      if (same(b.range.end, cut.boundary)) positions.add(i + 1);
    });
    if (basis.length && positions.size !== 1)
      throw new Error('Split cut is not in its exact author basis');
    const at = [...positions][0] ?? 0,
      captured = (retainedSide === 'left' ? basis.slice(at) : basis.slice(0, at)).map(
        (b) => b.range,
      );
    const p = this.firstPlaces.get(destination);
    if (!p) throw new Error('Split destination lacks placement');
    const parent = this.tree.draft.parentOf(destination) ?? p.parent;
    const before = this.tree.draft.nextSiblingOf(destination) ?? null;
    const slot = this.blockSlot(parent, before, destination);
    this.create(
      destination,
      { ...this.specs.get(destination)!, content: '' } as CreateNodeSpec,
      slot,
      captured,
      { basis: { ranges: basis }, cut, retainedSide },
    );
    const remaining = [...slice(original, 0, from), ...slice(original, to, Infinity)];
    this.text.set(
      source,
      retainedSide === 'left' ? slice(remaining, 0, from) : slice(remaining, from, Infinity),
    );
    this.text.set(
      destination,
      retainedSide === 'left' ? slice(remaining, from, Infinity) : slice(remaining, 0, from),
    );
  }
  private join(source: Handle, destination: Handle) {
    const sourceFlow = this.flow(source),
      at = this.length(destination),
      slot = this.boundary(destination, at, 'left'),
      occurrence = this.alloc('occurrence');
    this.allocations.push({ type: 'occurrence', id: occurrence, slot });
    this.effects.push({
      type: 'JoinFlow',
      source: sourceFlow,
      destination: slot,
      occurrence,
      liftedChildren: [],
    });
    this.text.set(destination, [...this.pieces(destination), ...this.pieces(source)]);
    this.text.set(source, []);
  }
  private move(id: Handle, parent: Handle, before: Handle | null) {
    const first = !this.seenPlacements.has(id);
    this.seenPlacements.add(id);
    if (!this.ids.has(id)) {
      if (!this.splitNodes.has(id)) this.id(id);
      return;
    }
    if (first && this.specs.has(id)) return;
    const node = this.id(id),
      slot = this.blockSlot(parent, before, id),
      ownership = this.ownership();

    const occurrence = this.alloc('occurrence');
    this.allocations.push({ type: 'occurrence', id: occurrence, slot });
    this.effects.push({
      type: 'MoveBlock',
      node,
      slot,
      occurrence,
      standaloneFlow: ownership.nodeAllocations.find((n) => same(n.id, node))!.flow,
    });
  }
  private lift(lift: ChildLift) {
    for (const child of lift.children) {
      const slot = this.blockSlot(lift.parent, lift.before, child),
        occurrence = this.alloc('occurrence'),
        node = this.id(child);
      this.allocations.push({ type: 'occurrence', id: occurrence, slot });
      this.tree.draft.place(child, lift.parent, lift.before);
      this.effects.push({ type: 'LiftChildren', placements: [{ node, slot, occurrence }] });
    }
    if (lift.removeSource) this.tree.draft.detach(lift.source);
  }
  private deleteSubtree(handle: Handle) {
    const ownership = this.ownership(),
      view = this.draft.origins.get(handle),
      targets = view?.origin.constituents ?? [this.id(handle)];
    for (const target of targets) {
      const observedNodes: NodeId[] = [],
        ownedIntervals: RangeRef[] = [],
        joinedFlows: FlowId[] = [];
      const visit = (node: NodeId) => {
        observedNodes.push(node);
        const flow = ownership.nodeAllocations.find((n) => same(n.id, node))?.flow;
        if (flow) {
          for (const e of ownership.raw(flow))
            if (e.type === 'cell') ownedIntervals.push(e.assignment.cell);
          for (const f of ownership.flowPlacements)
            if (f.parent.type === 'flow' && same(ownership.flowBlock(f.flow), node))
              joinedFlows.push(f.flow);
        }
        for (const child of ownership.children(node)) visit(child);
      };
      visit(target);
      const tag = this.alloc('deletion');
      this.allocations.push({ type: 'deletion', id: tag });
      this.effects.push({
        type: 'DeleteSubtree',
        tag,
        scope: {
          target,
          observedNodes,
          ownedIntervals,
          joinedFlows,
          heads: this.base.dependencies,
        },
      });
    }
  }
  /** A terminal parser packet uses retained fragments, never a diff of strings. */
  interpret(handle: Handle, plan: ParserConversionPlan): void {
    const source = this.id(handle),
      flow = this.flow(handle),
      ownership = this.ownership();
    const sourceRun = ownership.homeBindings.find((h) =>
      ownership.runLayouts.some((r) => same(r.run, h.run) && same(r.flow, flow)),
    )!.run;
    const parent = this.tree.draft.parentOf(handle);
    if (!parent) throw new Error('Parser source has no insertion parent');
    const rootSlot = this.blockSlot(parent, this.tree.draft.nextSiblingOf(handle) ?? null, handle);
    const bindings: OutputBinding[] = [],
      nodeByKey = new Map<string, MarkdownNode>();
    let first = true;
    const visit = (
      node: MarkdownNode,
      path: number[],
      parentBinding: OutputBinding | null,
      predecessor: OccurrenceId | null,
    ): OutputBinding => {
      const key = path.join('.'),
        inline = isInlineNode(node),
        stable = inline && first;
      if (inline) first = false;
      const id = stable ? source : this.alloc('node'),
        nodeFlow = inline ? (stable ? flow : this.alloc('flow')) : undefined,
        run = inline ? (stable ? sourceRun : this.alloc('run')) : undefined;
      const slot = parentBinding
        ? { parent: parentBinding.node, predecessor }
        : { ...rootSlot, predecessor: predecessor ?? rootSlot.predecessor };
      const occurrence = this.alloc('occurrence');
      if (!stable) {
        const birth = this.alloc('occurrence');
        this.allocations.push(
          {
            type: 'node',
            id,
            role: inline
              ? 'inline'
              : node.type === 'block-quote'
                ? 'quote'
                : (node.type as 'list' | 'list-item'),
            flow: nodeFlow ?? null,
            birthSlot: slot,
          },
          { type: 'occurrence', id: birth, slot },
        );
        if (nodeFlow && run) {
          const tape = this.alloc('tape'),
            start = this.alloc('marker'),
            end = this.alloc('marker');
          this.native.add({ type: 'createTape', tape, start, end });
          this.allocations.push(
            { type: 'flow', id: nodeFlow, home: id },
            { type: 'run', id: run, flow: nodeFlow, skeleton: [{ tape, start, end }] },
          );
        }
      }
      this.allocations.push({ type: 'occurrence', id: occurrence, slot });
      const binding: OutputBinding = {
        key,
        node: id,
        occurrence,
        slot,
        ...(nodeFlow && run ? { flow: nodeFlow, run } : {}),
      };
      bindings.push(binding);
      nodeByKey.set(key, node);
      let previous: OccurrenceId | null = null;
      for (const [i, child] of (node.children ?? []).entries()) {
        const b = visit(child, [...path, i], binding, previous);
        previous = b.occurrence;
      }
      return binding;
    };
    let previous: OccurrenceId | null = null;
    for (const [i, node] of (plan.output.children ?? []).entries()) {
      const b = visit(node, [i], null, previous);
      previous = b.occurrence;
    }
    const fragments = this.pieces(handle),
      text = fragments.map((p) => p.text).join('');
    let prepared: ReturnType<typeof prepareParserConversion>;
    try {
      prepared = prepareParserConversion({ source, text, fragments, plan, bindings });
    } catch (error) {
      if (error instanceof ProjectionError)
        throw new ConversionDeclined('invalid-conversion', error.message);
      throw error;
    }
    // A multi-inline interpretation also changes flow ownership. Its applicability
    // must be agreed with the projection contract before this compiler can lower it.
    if (prepared.outputs.filter((o) => isInlineNode(nodeByKey.get(o.binding.key)!)).length !== 1)
      throw new ConversionDeclined(
        'unsupported-conversion',
        'Multi-inline parser conversion is not supported by this compiler',
      );
    const packet = this.alloc('interpretation');
    this.allocations.push({ type: 'interpretation', id: packet });
    const synthesis: { request: string; ranges: readonly NativeTextRange[] }[] = [];
    for (const request of prepared.synthesis) {
      const output = prepared.outputs.find((o) =>
        o.pieces.some((p) => p.type === 'synthesize' && p.request === request.request),
      )!;
      let sourceOffset = 0;
      for (const piece of output.pieces) {
        if (piece.type === 'synthesize' && piece.request === request.request) break;
        if (piece.type === 'retain') {
          const last = piece.ranges.at(-1)!;
          const match = fragments.findIndex(
            (f) =>
              same(f.range.tape, last.tape) &&
              f.range.client === last.client &&
              f.range.clock <= last.clock &&
              last.clock < f.range.clock + f.range.length,
          );
          sourceOffset =
            fragments.slice(0, match).reduce((n, p) => n + p.text.length, 0) +
            last.clock +
            last.length -
            fragments[match].range.clock;
        }
      }
      const at = this.point(handle, sourceOffset, 'left'),
        index = new CellIndex(this.native.all()),
        homes = new HomeIndex(this.ownership().homeBindings, index);
      let ranges: readonly NativeTextRange[] = [];
      if (homes.isReserved(index.adjacent(at.slot.boundary, at.slot.side).range)) {
        for (const op of homes.planTextInsertion(at.slot, request.text, () => this.alloc('marker')))
          ranges = [...ranges, ...this.native.add(op)];
      } else
        ranges = this.native.add({
          type: 'text',
          tape: at.tape,
          index: at.index,
          text: request.text,
        });
      this.effects.push({ type: 'InsertText', ranges });
      synthesis.push({ request: request.request, ranges });
    }
    const retained = [
      ...this.genesis.layout.allocations,
      ...this.ready.flatMap((a) => a.allocations),
    ];
    const bound = bindParserConversion(
      prepared,
      packet,
      this.envelope(),
      synthesis,
      (r) =>
        this.native
          .lookup(r)
          .map((p) => p.text)
          .join(''),
      retained,
    );
    this.effects.push({ type: 'Interpret', packet: bound.packet });
    for (const output of prepared.outputs)
      if (output.type === 'list-item')
        this.effects.push({
          type: 'SetProperties',
          node: output.binding.node,
          values: { marker: output.properties.marker, checked: output.properties.checked },
        });
  }
  run(): void {
    if (this.draft.intents.every((i) => i.type === 'splice')) {
      for (const handle of new Set(
        this.draft.intents.map((i) => (i.type === 'splice' ? i.id : '')),
      )) {
        const original = this.pieces(handle),
          final = this.draft.pieces.get(handle) ?? [];
        const edits: TextEdit[] = [];
        let cursor = 0,
          pending = '';
        for (const p of final) {
          if (p.type === 'buffer') {
            pending += p.text;
            continue;
          }
          let base = 0,
            position: number | undefined;
          for (const source of original) {
            if (
              same(source.range.tape, p.range.tape) &&
              source.range.client === p.range.client &&
              source.range.clock <= p.range.clock &&
              p.range.clock + p.range.length <= source.range.clock + source.range.length
            ) {
              position = base + p.range.clock - source.range.clock;
              break;
            }
            base += source.text.length;
          }
          if (position === undefined || position < cursor)
            throw new Error('Text-only draft lost its retained source order');
          if (position > cursor || pending)
            edits.push({ from: cursor, to: position, insert: pending });
          cursor = position + p.text.length;
          pending = '';
        }
        if (cursor < this.length(handle) || pending)
          edits.push({ from: cursor, to: this.length(handle), insert: pending });
        for (const edit of edits.reverse()) this.splice(handle, edit);
      }
      return;
    }
    for (const intent of this.draft.intents) {
      switch (intent.type) {
        case 'create': {
          const id = this.tree.draft.create(intent.spec);
          if (id !== intent.id) throw new Error('Draft allocation order changed');
          break;
        }
        case 'place':
          this.move(intent.id, intent.parent, intent.before);
          this.tree.draft.place(intent.id, intent.parent, intent.before);
          break;
        case 'splice':
          this.splice(intent.id, intent.edit);
          break;
        case 'split':
          this.split(intent.split);
          break;
        case 'join':
          this.join(intent.source, intent.destination);
          this.tree.draft.detach(intent.source);
          break;
        case 'delete':
          this.deleteSubtree(intent.id);
          this.tree.draft.detach(intent.id);
          break;
        case 'lift':
          this.lift(intent.lift);
          break;
        case 'marker':
          this.effects.push({
            type: 'SetProperties',
            node: this.id(intent.id),
            values: { marker: intent.marker },
          });
          this.tree.draft.setMarker(intent.id, intent.marker);
          break;
        case 'checked':
          this.effects.push({
            type: 'SetProperties',
            node: this.id(intent.id),
            values: { checked: intent.checked },
          });
          this.tree.draft.setChecked(intent.id, intent.checked);
          break;
        case 'info':
          this.effects.push({
            type: 'SetProperties',
            node: this.id(intent.id),
            values: { info: intent.info },
          });
          this.tree.draft.setInfo(intent.id, intent.info);
          break;
        case 'convert': {
          const hidden =
            this.draft.origins
              .get(intent.id)
              ?.fragments.filter((f) => f.masked)
              .map((f) => f.range) ?? [];
          if (hidden.length) {
            const tag = this.alloc('deletion');
            this.allocations.push({ type: 'deletion', id: tag });
            this.effects.push({ type: 'DeleteText', tag, observed: hidden });
          }
          if (intent.plan.content?.mode === 'replace')
            this.splice(intent.id, {
              from: 0,
              to: this.length(intent.id),
              insert: intent.plan.content.text,
            });
          this.effects.push({
            type: 'SetProperties',
            node: this.id(intent.id),
            values: {
              presentation:
                intent.plan.type === 'section'
                  ? 'section'
                  : intent.plan.type === 'code-block'
                    ? 'code'
                    : 'paragraph',
              marker: intent.plan.type === 'section' ? (intent.plan.marker ?? '#') : null,
              info: intent.plan.type === 'code-block' ? (intent.plan.info ?? null) : null,
            },
          });
          this.tree.draft.convertInline(intent.id, intent.plan);
          break;
        }
        case 'cut': {
          const pieces = slice(this.pieces(intent.id), intent.from, intent.to);
          this.boundary(intent.id, intent.to, 'right');
          this.boundary(intent.id, intent.from, 'left');
          const ownership = this.ownership();
          const ranges = ownership
            .raw(this.flow(intent.id))
            .flatMap((e) =>
              e.type === 'cell' &&
              e.fragments.some((p) =>
                pieces.some(
                  (s) =>
                    same(s.range.tape, p.range.tape) &&
                    s.range.client === p.range.client &&
                    Math.max(s.range.clock, p.range.clock) <
                      Math.min(s.range.clock + s.range.length, p.range.clock + p.range.length),
                ),
              )
                ? [e.assignment.cell]
                : [],
            );
          this.fragments.set(intent.fragment, { ranges, pieces });
          this.replace(intent.id, intent.from, intent.to, []);
          break;
        }
        case 'insert-fragment': {
          const f = this.fragments.get(intent.fragment);
          if (!f) throw new Error('Missing compiler fragment');
          const destination = this.boundary(intent.id, intent.at, intent.affinity),
            flow = this.flow(intent.id),
            run = this.alloc('run'),
            occurrence = this.alloc('occurrence');
          this.allocations.push(
            { type: 'run', id: run, flow, skeleton: f.ranges },
            { type: 'occurrence', id: occurrence, slot: destination },
          );
          this.effects.push({
            type: 'TransferRange',
            ranges: f.ranges,
            destination,
            run,
            occurrence,
          });
          this.replace(intent.id, intent.at, intent.at, f.pieces);
          this.fragments.delete(intent.fragment);
          break;
        }
      }
    }
    if (this.fragments.size) throw new Error('Uninserted move-only fragment');
  }
  bind(
    native: NativeView,
    body: Pick<ActionEnvelope, 'allocations' | 'nativeInsertUpdates' | 'nativeManifest'>,
  ): ActionEnvelope {
    const ranges = (rs: readonly NativeTextRange[]) =>
      rs.flatMap((r) => this.native.bind(r, native));
    return {
      ...this.base,
      allocations: [...this.allocations, ...body.allocations],
      nativeInsertUpdates: body.nativeInsertUpdates,
      nativeManifest: body.nativeManifest,
      effects: this.effects.map((e) => {
        if (e.type === 'InsertText') return { ...e, ranges: ranges(e.ranges) };
        if (e.type === 'DeleteText') return { ...e, observed: ranges(e.observed) };
        if (e.type === 'Interpret')
          return {
            ...e,
            packet: {
              ...e.packet,
              syntaxMask: ranges(e.packet.syntaxMask),
              synthesizedText: ranges(e.packet.synthesizedText),
            },
          };
        return e;
      }),
    };
  }
  resource(handle: Handle) {
    return this.ids.get(handle);
  }
}
