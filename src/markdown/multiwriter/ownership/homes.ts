import type {
  CellAssignment,
  InlineSlot,
  MarkerId,
  RangeRef,
  RunId,
  SemanticEffect,
} from '../contracts.js';
import type { NativeInsertion } from '../text/types.js';
import type { LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { cellKey, sameId } from './cells.js';
import type { CellIndex } from './cells.js';

/** A full private tape range, bound by the root run's last skeleton element. */
export type HomeBinding = CellAssignment;

/** Derive from retained births, never from overlapping capture skeletons or array order. */
export function deriveHomes(
  batch: LayoutGenesis,
  effects: readonly SemanticEffect[] = [],
): readonly HomeBinding[] {
  const transfers = new Set(
    effects.flatMap((effect) => (effect.type === 'TransferRange' ? [resourceKey(effect.run)] : [])),
  );
  const runs = batch.allocations
    .filter((entry) => entry.type === 'run')
    .filter((entry) => !transfers.has(resourceKey(entry.id)));
  const flows = batch.allocations.filter((entry) => entry.type === 'flow');
  const tapes = batch.allocations.filter((entry) => entry.type === 'tape');
  // Build disposable indexes from this batch. Duplicate roots still count as
  // ambiguity; first tape/birth matches retain the full scan's lookup semantics.
  const byFlow = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = resourceKey(run.flow),
      group = byFlow.get(key) ?? [];
    group.push(run);
    byFlow.set(key, group);
  }
  const byTape = new Map<string, (typeof tapes)[number]>();
  for (const tape of tapes) {
    const key = resourceKey(tape.id);
    if (!byTape.has(key)) byTape.set(key, tape);
  }
  const byNode = new Map<string, (typeof batch.births)[number]>();
  for (const birth of batch.births) {
    const key = resourceKey(birth.node);
    if (!byNode.has(key)) byNode.set(key, birth);
  }
  const homes: HomeBinding[] = [];
  for (const flow of flows) {
    const roots = byFlow.get(resourceKey(flow.id)) ?? [];
    if (roots.length !== 1) throw new Error('Flow needs exactly one retained root run');
    const run = roots[0];
    const range = run.skeleton.at(-1);
    const tape = range && byTape.get(resourceKey(range.tape));
    if (!range || !tape || !sameId(range.start, tape.start) || !sameId(range.end, tape.end))
      throw new Error('Root run must end with its fresh full home tape');
    const birth = byNode.get(resourceKey(flow.home));
    if (!birth) throw new Error('Missing home run occurrence binding');
    homes.push({ cell: range, run: run.id, occurrence: birth.occurrence });
  }
  if (runs.length !== homes.length)
    throw new Error('Non-transfer root run must be born with its flow');
  if (
    tapes.length !== homes.length ||
    new Set(homes.map((home) => resourceKey(home.cell.tape))).size !== tapes.length
  )
    throw new Error('Each fresh tape needs one distinct private home binding');
  if (new Set(homes.map((home) => resourceKey(home.occurrence))).size !== homes.length)
    throw new Error('Each home root needs a distinct birth occurrence');
  return structuredClone(homes);
}

/** Disposable classification at this complete native prefix. Refinement changes the edge cells. */
export class HomeIndex {
  private readonly byRun = new Map<string, HomeBinding>();
  private readonly byTape = new Map<string, HomeBinding>();
  private readonly reserved = new Set<string>();
  constructor(
    bindings: readonly HomeBinding[],
    private readonly index: Pick<CellIndex, keyof CellIndex>,
  ) {
    for (const home of structuredClone(bindings)) {
      if (this.byRun.has(resourceKey(home.run)) || this.byTape.has(resourceKey(home.cell.tape)))
        throw new Error('Duplicate private home binding');
      this.byRun.set(resourceKey(home.run), home);
      this.byTape.set(resourceKey(home.cell.tape), home);
      const cells = index.range(home.cell);
      for (const cell of [cells[0], cells.at(-1)!]) {
        if (cell.fragments.length)
          throw new Error('Reserved home cells must remain text-free; bracket edge typing');
        this.reserved.add(cellKey(cell.range));
      }
    }
  }
  /** Author-side lowering only; replay consumes retained brackets and identities. */
  planTextInsertion(
    slot: InlineSlot,
    text: string,
    allocateMarker: () => MarkerId,
  ): readonly NativeInsertion[] {
    if (!text.length) return [];
    const cell = this.index.adjacent(slot.boundary, slot.side);
    const tape = cell.range.tape;
    const position = this.index.position(tape, slot.boundary) + (slot.side === 'right' ? 1 : 0);
    if (!this.isReserved(cell.range)) return [{ type: 'text', tape, index: position, text }];
    return [
      { type: 'marker', tape, index: position, marker: allocateMarker(), affinity: 'left' },
      { type: 'text', tape, index: position + 1, text },
      {
        type: 'marker',
        tape,
        index: position + 1 + text.length,
        marker: allocateMarker(),
        affinity: 'right',
      },
    ];
  }

  home(run: RunId): HomeBinding {
    const home = this.byRun.get(resourceKey(run));
    if (!home) throw new Error('Cut run is not a bound home root');
    return structuredClone(home);
  }
  isReserved(cell: RangeRef): boolean {
    return this.reserved.has(cellKey(cell));
  }
  assertCapture(range: RangeRef): void {
    const home = this.byTape.get(resourceKey(range.tape));
    if (!home) throw new Error('Capture uses a tape without a home binding');
    const start = this.index.position(range.tape, range.start);
    const end = this.index.position(range.tape, range.end);
    if (
      start <= this.index.position(range.tape, home.cell.start) ||
      end >= this.index.position(range.tape, home.cell.end)
    )
      throw new Error('Structural captures need interior home endpoints');
    this.index.range(range);
  }
}
