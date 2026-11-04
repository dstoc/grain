import { parseBlocks } from '../../../src/markdown/block-parser/api.js';
import {
  resolveAddress,
  prepareParserConversion,
  bindParserConversion,
} from '../../../src/markdown/multiwriter/projection/index.js';
import type { PreparedConversion } from '../../../src/markdown/multiwriter/projection/index.js';
import type {
  ActionEnvelope,
  ActionId,
  Allocation,
  InlineSlot,
  NativeTextRange,
  RangeRef,
  ResourceId,
  ResourceKind,
  SemanticEffect,
} from '../../../src/markdown/multiwriter/contracts.js';
import { resourceKey } from '../../../src/markdown/multiwriter/layout/index.js';
import { CellIndex, HomeIndex } from '../../../src/markdown/multiwriter/ownership/index.js';
import { NativeTapeCache } from '../../../src/markdown/multiwriter/text/cache.js';
import type {
  NativeInsertion,
  TapeSnapshot,
} from '../../../src/markdown/multiwriter/text/cache.js';
import type { TraceAction } from '../trace.js';
import type { openReferenceDocument } from '../../../src/markdown/multiwriter/reference/document.js';

export interface Aliases {
  ids: Map<string, ResourceId<ResourceKind>>;
  text: Map<string, NativeTextRange>;
  ranges: Map<string, RangeRef>;
  slots: Map<string, InlineSlot>;
}
export type ReferenceDocument = ReturnType<typeof openReferenceDocument>;
/** Allocation roles are a test observation convention, never a reducer/birth-binding rule.
 * Gaps between intent ranges keep aliases reconstructible without native clock guesses.
 */
export function role<K extends ResourceKind>(
  id: ActionId,
  intent: number,
  offset: number,
  kind: K,
): ResourceId<K> {
  return { kind, birth: { type: 'action', action: id }, ordinal: (intent + 1) * 10000 + offset };
}
export function get<K extends ResourceKind>(a: Aliases, name: string, kind: K): ResourceId<K> {
  const id = a.ids.get(name);
  if (!id || id.kind !== kind) throw new Error(`Unavailable ${kind} alias ${name}`);
  return id as ResourceId<K>;
}

/** Only indexes/marker positions are simulated. Native strings and IDs are allocated
 * once by prepare(); this draft never becomes a document or a replay input.
 */
class NativePlan {
  readonly operations: NativeInsertion[] = [];
  private readonly snapshots = new Map<string, TapeSnapshot>();
  constructor(snapshots: readonly TapeSnapshot[]) {
    for (const snapshot of snapshots)
      this.snapshots.set(resourceKey(snapshot.tape), structuredClone(snapshot));
  }
  all() {
    return [...this.snapshots.values()];
  }
  marker(id: ResourceId<'marker'>) {
    for (const snapshot of this.snapshots.values()) {
      const part = snapshot.parts.find(
        (p) => p.type === 'marker' && resourceKey(p.marker) === resourceKey(id),
      );
      if (part) return { tape: snapshot.tape, index: part.index };
    }
    throw new Error('Unavailable planned marker');
  }
  add(op: NativeInsertion) {
    this.operations.push(op);
    if (op.type === 'createTape') {
      this.snapshots.set(resourceKey(op.tape), {
        tape: op.tape,
        length: 2,
        parts: [
          {
            type: 'marker',
            marker: op.start,
            index: 0,
            native: { client: 0, clock: op.start.ordinal },
            affinity: 'left',
          },
          {
            type: 'marker',
            marker: op.end,
            index: 1,
            native: { client: 0, clock: op.end.ordinal },
            affinity: 'right',
          },
        ],
      });
      return;
    }
    const snapshot = this.snapshots.get(resourceKey(op.tape))!;
    const size = op.type === 'text' ? op.text.length : 1;
    const parts = snapshot.parts.flatMap((part) => {
      if (part.index >= op.index) return [{ ...part, index: part.index + size }];
      if (part.type === 'text' && op.index < part.index + part.text.length) {
        const cut = op.index - part.index;
        return [
          { ...part, text: part.text.slice(0, cut) },
          {
            ...part,
            index: op.index + size,
            text: part.text.slice(cut),
            native: { ...part.native, clock: part.native.clock + cut },
          },
        ];
      }
      return [part];
    });
    parts.push(
      op.type === 'text'
        ? {
            type: 'text',
            index: op.index,
            text: op.text,
            native: { client: 0, clock: 1000000 + this.operations.length * 10000 },
          }
        : {
            type: 'marker',
            index: op.index,
            marker: op.marker,
            affinity: op.affinity,
            native: { client: 0, clock: op.marker.ordinal },
          },
    );
    parts.sort((a, b) => a.index - b.index);
    this.snapshots.set(resourceKey(op.tape), {
      ...snapshot,
      length: snapshot.length + size,
      parts,
    });
  }
}

export function prepareAction(input: {
  command: TraceAction;
  id: ActionId;
  session: string;
  document: ReferenceDocument;
  native: NativeTapeCache;
  aliases: Aliases;
  envelope(name: string): ActionEnvelope;
}) {
  const { command, id, document, native, aliases: a } = input;
  const status = document.publication.status();
  if (status.stale || !status.canAuthor || !status.publication)
    throw new Error('Reference publication is not editable');
  const p = status.publication;
  const ownership = p.value.ownership;
  const plan = new NativePlan(
    ownership.homeBindings.map((home) => native.snapshot(home.cell.tape)),
  );
  const allocations: Allocation[] = [];
  const effects: SemanticEffect[] = [];
  const plannedTextNames: string[] = [];
  const parserPackets = new Map<
    number,
    { prepared: PreparedConversion; id: ResourceId<'interpretation'> }
  >();
  const packetTexts = new Map<
    number,
    { mask: readonly string[]; synthesized: readonly string[] }
  >();
  const homes = [...ownership.homeBindings];
  const textRanges = (names: readonly string[]) =>
    names.map((name) => {
      const range = a.text.get(name);
      if (!range) throw new Error(`Unavailable native text alias ${name}`);
      return range;
    });
  const ranges = (names: readonly string[]) =>
    names.map((name) => {
      const range = a.ranges.get(name);
      if (!range) throw new Error(`Unavailable cell alias ${name}`);
      return range;
    });
  const slot = (name: string) => {
    const suffix = /:(left|right)$/.exec(name);
    const base = suffix ? a.slots.get(name.slice(0, -suffix[0].length)) : undefined;
    const value =
      a.slots.get(name) ??
      (base && suffix ? { ...base, side: suffix[1] as 'left' | 'right' } : undefined);
    if (!value) throw new Error(`Unavailable insertion slot ${name}`);
    if (
      !allocations.some(
        (entry) => entry.type === 'run' && resourceKey(entry.id) === resourceKey(value.run),
      )
    ) {
      const resolved = ownership.resolveSlot(value);
      const origin = resolved.run.skeleton.find((range) =>
        ownership.containsBoundary(range, value.boundary),
      );
      if (
        !origin ||
        resolveAddress({ type: 'text', slot: value, origin }, ownership, p.value.visibility)
          .state !== 'available'
      )
        throw new Error('Unavailable projected insertion address');
    }
    return value;
  };
  for (const [i, intent] of command.intents.entries()) {
    const alloc = <K extends ResourceKind>(offset: number, kind: K) => role(id, i, offset, kind);
    const occurrence = alloc(6, 'occurrence');
    switch (intent.type) {
      case 'split': {
        const node = alloc(0, 'node'),
          flow = alloc(1, 'flow'),
          run = alloc(2, 'run');
        const tape = alloc(3, 'tape'),
          start = alloc(4, 'marker'),
          end = alloc(5, 'marker');
        const outerSlot = {
          parent: get(a, intent.parent, 'node'),
          predecessor: intent.predecessor ? get(a, intent.predecessor, 'occurrence') : null,
        };
        const basis = ranges(intent.basis).map((range) => {
          const assignments = ownership.cells(range);
          if (new Set(assignments.map((v) => resourceKey(v.occurrence))).size !== 1)
            throw new Error('Trace cell crosses ownership occurrences');
          return { range, occurrence: assignments[0].occurrence };
        });
        const source = get(a, intent.source, 'node');
        const sourceNode = ownership.nodeAllocations.find(
          (v) => resourceKey(v.id) === resourceKey(source),
        )!;
        const sourceHome = homes.find((h) =>
          ownership.runLayouts.some(
            (r) =>
              resourceKey(r.run) === resourceKey(h.run) &&
              resourceKey(r.flow) === resourceKey(sourceNode.flow!),
          ),
        )!;
        const boundary = basis.length ? alloc(7, 'marker') : sourceHome.cell.end;
        if (basis.length) {
          const before =
            intent.after === null
              ? plan.marker(basis[0].range.start).index + 1
              : native.locate(a.text.get(intent.after)!.tape, a.text.get(intent.after)!) +
                a.text.get(intent.after)!.length;
          plan.add({
            type: 'marker',
            tape: basis[0].range.tape,
            index: before,
            marker: boundary,
            affinity: 'right',
          });
        }
        const captured: RangeRef[] = [];
        if (basis.length) {
          const cut = plan.marker(boundary);
          for (const { range } of basis) {
            const left = plan.marker(range.start),
              right = plan.marker(range.end);
            if (resourceKey(range.tape) !== resourceKey(cut.tape)) {
              const index = basis.findIndex(
                (b) => resourceKey(b.range.tape) === resourceKey(cut.tape),
              );
              const at = basis.findIndex((b) => b.range === range);
              if (
                (intent.retainedSide === 'left' && at > index) ||
                (intent.retainedSide === 'right' && at < index)
              )
                captured.push(range);
            } else if (intent.retainedSide === 'left' && right.index > cut.index)
              captured.push({ ...range, start: left.index < cut.index ? boundary : range.start });
            else if (intent.retainedSide === 'right' && left.index < cut.index)
              captured.push({ ...range, end: right.index > cut.index ? boundary : range.end });
          }
        }
        plan.add({ type: 'createTape', tape, start, end });
        const home = { tape, start, end };
        allocations.push(
          { type: 'node', id: node, role: 'inline', flow, birthSlot: outerSlot },
          { type: 'flow', id: flow, home: node },
          { type: 'run', id: run, flow, skeleton: [...captured, home] },
          { type: 'occurrence', id: occurrence, slot: outerSlot },
        );
        homes.push({ cell: home, run, occurrence });
        effects.push({
          type: 'SplitFlow',
          basis: { ranges: basis },
          cut: {
            run: sourceHome.run,
            boundary,
            side: basis.length ? 'right' : 'left',
            predecessor: null,
          },
          retainedSide: intent.retainedSide,
          newNode: node,
          newFlow: flow,
          newRun: run,
          occurrence,
          outerSlot,
        });
        break;
      }
      case 'join': {
        const destination = slot(intent.destinationSlot);
        allocations.push({ type: 'occurrence', id: occurrence, slot: destination });
        effects.push({
          type: 'JoinFlow',
          source: get(a, intent.source, 'flow'),
          destination,
          occurrence,
          liftedChildren: [],
        });
        break;
      }
      case 'transfer': {
        const destination = slot(intent.destinationSlot);
        const run = alloc(2, 'run');
        const flow = ownership.runLayouts.find(
          (r) => resourceKey(r.run) === resourceKey(destination.run),
        )!.flow;
        const selected = ranges(intent.cells);
        allocations.push(
          { type: 'run', id: run, flow, skeleton: selected },
          { type: 'occurrence', id: occurrence, slot: destination },
        );
        effects.push({ type: 'TransferRange', ranges: selected, destination, run, occurrence });
        break;
      }
      case 'insert': {
        if (intent.text.length) plannedTextNames.push(intent.cell);
        let nextMarker = 10;
        const insertion = slot(intent.slot);
        if (
          resourceKey(get(a, intent.tape, 'tape')) !==
          resourceKey(plan.marker(insertion.boundary).tape)
        )
          throw new Error('Trace tape differs from insertion origin');
        const index = new CellIndex(plan.all());
        for (const operation of new HomeIndex(homes, index).planTextInsertion(
          insertion,
          intent.text,
          () => alloc(nextMarker++, 'marker'),
        ))
          plan.add(operation);
        break;
      }
      case 'move': {
        const destination = {
          parent: get(a, intent.parent, 'node'),
          predecessor: intent.predecessor ? get(a, intent.predecessor, 'occurrence') : null,
        };
        allocations.push({ type: 'occurrence', id: occurrence, slot: destination });
        effects.push({
          type: 'MoveBlock',
          node: get(a, intent.node, 'node'),
          occurrence,
          slot: destination,
          standaloneFlow: intent.standaloneFlow ? get(a, intent.standaloneFlow, 'flow') : null,
        });
        break;
      }
      case 'delete-text': {
        const tag = alloc(0, 'deletion');
        allocations.push({ type: 'deletion', id: tag });
        effects.push({ type: 'DeleteText', tag, observed: textRanges(intent.cells) });
        break;
      }
      case 'delete-subtree': {
        const tag = alloc(0, 'deletion');
        allocations.push({ type: 'deletion', id: tag });
        effects.push({
          type: 'DeleteSubtree',
          tag,
          scope: {
            target: get(a, intent.target, 'node'),
            observedNodes: intent.observedNodes.map((n) => get(a, n, 'node')),
            ownedIntervals: ranges(intent.coveredCells),
            joinedFlows: intent.joinedFlows.map((n) => get(a, n, 'flow')),
            heads: p.heads,
          },
        });
        break;
      }
      case 'parse': {
        const source = get(a, intent.source, 'node');
        const find = (node: typeof p.value.view.root): typeof node | undefined =>
          resourceKey(node.origin.representative) === resourceKey(source)
            ? node
            : node.children.map(find).find(Boolean);
        const view = find(p.value.view.root);
        if (!view) throw new Error('Parser source is not visible');
        const plan = parseBlocks(view.content, { provenance: true }).provenance!;
        const binding = ownership.blockPlacement(source);
        const sourceNode = ownership.nodeAllocations.find(
          (n) => resourceKey(n.id) === resourceKey(source),
        )!;
        const home = ownership.homeBindings.find((home) =>
          ownership.runLayouts.some(
            (run) =>
              resourceKey(run.run) === resourceKey(home.run) &&
              resourceKey(run.flow) === resourceKey(sourceNode.flow!),
          ),
        )!;
        if (
          !binding ||
          !home ||
          plan.output.children?.length !== 1 ||
          plan.output.children[0].children?.length
        )
          throw new Error('Reference parser author requires one inline output');
        const occurrence = alloc(100, 'occurrence'),
          packet = alloc(0, 'interpretation');
        const prepared = prepareParserConversion({
          source,
          text: view.content,
          plan,
          fragments: view.fragments
            .filter((f) => f.visible)
            .map((f) => ({ text: f.text, range: f.range })),
          bindings: [
            {
              key: '0',
              node: source,
              flow: sourceNode.flow!,
              run: home.run,
              occurrence,
              slot: binding.slot,
            },
          ],
        });
        if (prepared.synthesis.length)
          throw new Error('Reference parser author requires explicit editable synthesis');
        allocations.push(
          { type: 'interpretation', id: packet },
          { type: 'occurrence', id: occurrence, slot: binding.slot },
        );
        parserPackets.set(effects.length, { prepared, id: packet });
        effects.push({
          type: 'Interpret',
          packet: {
            id: packet,
            source,
            properties: prepared.outputs[0].properties,
            wrappers: [],
            placements: [],
            syntaxMask: prepared.syntaxMask,
            synthesizedText: [],
          },
        });
        break;
      }
      case 'properties':
        effects.push({
          type: 'SetProperties',
          node: get(a, intent.node, 'node'),
          values: intent.values,
        });
        break;
      case 'interpret': {
        const placements = (intent.placements ?? []).map((placement, j) => {
          const occurrence = alloc(100 + j, 'occurrence');
          const slot = {
            parent: get(a, placement.parent, 'node'),
            predecessor: placement.predecessor ? get(a, placement.predecessor, 'occurrence') : null,
          };
          allocations.push({ type: 'occurrence', id: occurrence, slot });
          return { node: get(a, placement.node, 'node'), occurrence, slot };
        });
        packetTexts.set(effects.length, {
          mask: intent.mask,
          synthesized: intent.synthesized ?? [],
        });
        const packet = alloc(0, 'interpretation');
        allocations.push({ type: 'interpretation', id: packet });
        effects.push({
          type: 'Interpret',
          packet: {
            id: packet,
            source: get(a, intent.source, 'node'),
            properties: {
              presentation: intent.presentation,
              marker: intent.presentation === 'section' ? '#' : null,
              info: null,
            },
            wrappers: intent.wrappers.map((n) => get(a, n, 'node')),
            placements,
            syntaxMask: [],
            synthesizedText: [],
          },
        });
        break;
      }
      case 'control': {
        const target = input.envelope(intent.actions[0]);
        effects.push({
          type: 'SetGroupActive',
          group: target.groupId,
          actions: intent.actions.map((n) => input.envelope(n).id),
          active: intent.active,
          previousControl: intent.previous ? input.envelope(intent.previous).id : null,
        });
        break;
      }
      case 'create': {
        const b = intent.block;
        const node = alloc(0, 'node'),
          flow = b.flow ? alloc(1, 'flow') : null;
        const birthSlot = b.parent
          ? {
              parent: get(a, b.parent, 'node'),
              predecessor: intent.predecessor ? get(a, intent.predecessor, 'occurrence') : null,
            }
          : null;
        allocations.push({ type: 'node', id: node, role: b.role, flow, birthSlot });
        a.ids.set(b.id, node);
        a.ids.set(`${b.id}:birth`, occurrence);
        if (flow) {
          a.ids.set(b.flow!, flow);
          a.ids.set(b.run!, alloc(2, 'run'));
          a.ids.set(b.tape!, alloc(3, 'tape'));
        }
        if (birthSlot) allocations.push({ type: 'occurrence', id: occurrence, slot: birthSlot });
        if (flow) {
          const run = alloc(2, 'run'),
            tape = alloc(3, 'tape'),
            start = alloc(4, 'marker'),
            end = alloc(5, 'marker');
          plan.add({ type: 'createTape', tape, start, end });
          let previous = start;
          if (b.cells?.length) {
            previous = alloc(7, 'marker');
            plan.add({ type: 'marker', tape, index: 1, marker: previous, affinity: 'left' });
          }
          let index = b.cells?.length ? 2 : 1;
          for (const [j, cell] of (b.cells ?? []).entries()) {
            if (cell.text.length) plannedTextNames.push(cell.id);
            plan.add({ type: 'text', tape, index, text: cell.text });
            index += cell.text.length;
            const after = alloc(20 + j, 'marker');
            plan.add({ type: 'marker', tape, index: index++, marker: after, affinity: 'right' });
            a.ranges.set(cell.id, { tape, start: previous, end: after });
            a.slots.set(`${b.id}:after-${cell.text}`, {
              run,
              boundary: after,
              side: 'right',
              predecessor: null,
            });
            previous = after;
          }
          const home = { tape, start, end };
          allocations.push(
            { type: 'flow', id: flow, home: node },
            { type: 'run', id: run, flow, skeleton: [home] },
          );
          homes.push({ cell: home, run, occurrence });
          a.slots.set(`${b.id}:home-end`, { run, boundary: end, side: 'left', predecessor: null });
          a.slots.set(`${b.id}:end`, { run, boundary: end, side: 'left', predecessor: null });
          a.slots.set(`${b.id}:start`, { run, boundary: start, side: 'right', predecessor: null });
        }
        break;
      }
    }
  }
  const group = input.envelope;
  const existingGroup =
    command.group !== command.id
      ? group(command.group).groupId
      : { session: { actor: id.actor, local: input.session }, sequence: id.sequence };
  const dependencies = [
    ...new Map(
      [
        ...command.dependencies.map((n) => input.envelope(n).id),
        ...(id.sequence > 1n ? [{ actor: id.actor, sequence: id.sequence - 1n }] : []),
      ].map((v) => [`${v.actor}:${v.sequence}`, v]),
    ).values(),
  ];
  const prepared = native.prepare(`${id.actor}:${id.sequence}`, plan.operations);
  const inserted = prepared.body.nativeManifest.flatMap((entry) =>
    entry.type === 'text' ? [{ tape: entry.tape, ...entry.native }] : [],
  );
  if (inserted.length !== plannedTextNames.length) {
    prepared.abort();
    throw new Error('Text alias roles do not match native insertion fragments');
  }
  const bornText = new Map(plannedTextNames.map((name, index) => [name, inserted[index]]));
  for (const [ordinal, names] of packetTexts) {
    const effect = effects[ordinal];
    if (effect.type !== 'Interpret') throw new Error('Missing drafted interpretation');
    const resolve = (name: string) => bornText.get(name) ?? a.text.get(name);
    const masks = names.mask.map(resolve),
      synthesized = names.synthesized.map(resolve);
    if (masks.some((v) => !v) || synthesized.some((v) => !v)) {
      prepared.abort();
      throw new Error('Unavailable interpretation text identity');
    }
    effects[ordinal] = {
      ...effect,
      packet: {
        ...effect.packet,
        syntaxMask: masks as NativeTextRange[],
        synthesizedText: synthesized as NativeTextRange[],
      },
    };
  }
  const envelope: ActionEnvelope = {
    protocolVersion: 3,
    documentId: 'D',
    genesisId: 'G',
    id,
    lamport: command.lamport,
    dependencies,
    groupId: existingGroup,
    allocations: [...allocations, ...prepared.body.allocations],
    nativeInsertUpdates: prepared.body.nativeInsertUpdates,
    nativeManifest: prepared.body.nativeManifest,
    effects: [
      ...effects,
      ...(inserted.length ? [{ type: 'InsertText' as const, ranges: inserted }] : []),
    ],
  };
  try {
    const effects = [...envelope.effects];
    for (const [ordinal, packet] of parserPackets) {
      const bound = bindParserConversion(
        packet.prepared,
        packet.id,
        envelope,
        [],
        (range) =>
          native
            .lookup(range)
            .map((part) => part.text)
            .join(''),
        [
          ...ownership.nodeAllocations,
          ...ownership.flowPlacements.map((flow) => ({
            type: 'flow' as const,
            id: flow.flow,
            home: ownership.nodeAllocations.find(
              (node) => node.flow && resourceKey(node.flow) === resourceKey(flow.flow),
            )!.id,
          })),
          ...ownership.runLayouts.map((run) => ({
            type: 'run' as const,
            id: run.run,
            flow: run.flow,
            skeleton: run.skeleton,
          })),
        ],
      );
      effects[ordinal] = { type: 'Interpret', packet: bound.packet };
    }
    return {
      envelope: { ...envelope, effects },
      commit: () => prepared.commit(),
      abort: () => prepared.abort(),
    };
  } catch (error) {
    prepared.abort();
    throw error;
  }
}
