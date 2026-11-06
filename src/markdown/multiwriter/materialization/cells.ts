import { countWork, touchWork } from '../diagnostics.js';
import { CellIndex } from '../ownership/cells.js';
import type { NativeCell } from '../ownership/cells.js';
import type { MarkerId, NativeId, NativeTextRange, RangeRef, TapeId } from '../contracts.js';
import type { TapeSnapshot } from '../text/types.js';
import { resourceKey } from '../layout/index.js';
import { PersistentMap } from './map.js';
import type { NativeView } from '../ingest/publication.js';
import { indexedNativeCell, hasIndexedNative } from './native.js';
import { cellKey } from '../ownership/cells.js';

function nativeCell(native: NativeView, range: RangeRef): NativeCell {
  return {
    range,
    get fragments() {
      return native.range(range);
    },
  };
}

/** Immutable tape-local cell roots. Refinement replaces only affected tape indexes. */
export class MaterializedCells {
  private tapes = new PersistentMap<CellIndex>();
  private markers = new PersistentMap<{
    readonly tape: TapeId;
    readonly left?: NativeCell;
    readonly right?: NativeCell;
  }>();
  private reused = new PersistentMap<true>();
  constructor(
    snapshots: readonly TapeSnapshot[],
    private readonly onRead?: (range: RangeRef) => void,
    private readonly native?: NativeView,
  ) {
    this.install(snapshots);
  }
  /** A replay-local facade records semantic reads without changing published roots. */
  observing(onRead: (range: RangeRef) => void): MaterializedCells {
    const copy = new MaterializedCells([], onRead, this.native);
    copy.tapes = this.tapes;
    copy.markers = this.markers;
    copy.reused = this.reused;
    return copy;
  }
  refine(snapshots: readonly TapeSnapshot[], native?: NativeView): MaterializedCells {
    const copy = new MaterializedCells(
      [],
      undefined,
      native && hasIndexedNative(native) ? native : this.native,
    );
    copy.tapes = this.tapes.fork();
    copy.markers = this.markers.fork();
    copy.reused = this.reused.fork();
    copy.install(snapshots);
    return copy;
  }
  /** Text insertion preserves marker topology. Resolve fragments and newly born
   * IDs from this exact immutable native view without rebuilding a cell tape.
   */
  withNative(native: NativeView, tapes: readonly TapeId[]): MaterializedCells {
    if (!hasIndexedNative(native)) throw new Error('Cell reuse requires indexed native identity');
    const copy = new MaterializedCells([], undefined, native);
    copy.tapes = this.tapes;
    copy.markers = this.markers;
    copy.reused = this.reused.fork();
    for (const tape of tapes) {
      this.index(tape);
      copy.reused.set(resourceKey(tape), true);
    }
    return copy;
  }
  private nativeFor(tape: TapeId): NativeView | undefined {
    return this.reused.has(resourceKey(tape)) ? this.native : undefined;
  }
  private cellsFor(cells: readonly NativeCell[]): readonly NativeCell[] {
    const native = cells[0] && this.nativeFor(cells[0].range.tape);
    return native ? cells.map((cell) => nativeCell(native, cell.range)) : cells;
  }
  private install(snapshots: readonly TapeSnapshot[]): void {
    for (const snapshot of snapshots) {
      countWork('cells.tapesRebuilt');
      touchWork('tapes.rebuilt', resourceKey(snapshot.tape));
      countWork('cells.partsTraversed', snapshot.parts.length);
      const index = new CellIndex([snapshot]),
        cells = index.cells;
      countWork('cells.cellsRebuilt', cells.length);
      this.tapes.set(resourceKey(snapshot.tape), index);
      this.reused.delete(resourceKey(snapshot.tape));
      if (cells[0])
        this.markers.set(resourceKey(cells[0].range.start), {
          tape: snapshot.tape,
          right: cells[0],
        });
      for (let i = 0; i < cells.length; i++)
        this.markers.set(resourceKey(cells[i].range.end), {
          tape: snapshot.tape,
          left: cells[i],
          right: cells[i + 1],
        });
    }
  }
  private index(tape: TapeId): CellIndex {
    const index = this.tapes.get(resourceKey(tape));
    if (!index) throw new Error('Missing native tape snapshot');
    return index;
  }
  get cells(): readonly NativeCell[] {
    return [...this.tapes.values()].flatMap((index) => {
      const cells = index.cells;
      if (cells[0])
        this.onRead?.({
          tape: cells[0].range.tape,
          start: cells[0].range.start,
          end: cells.at(-1)!.range.end,
        });
      return this.cellsFor(cells);
    });
  }
  // Retained marker order is checked before reuse. Position/membership queries
  // alone do not depend on new cells; range/adjacency/token reads do.
  position(tape: TapeId, marker: MarkerId): number {
    const native = this.nativeFor(tape);
    if (!native) return this.index(tape).position(tape, marker);
    const found = native.marker(marker);
    if (resourceKey(found.tape) !== resourceKey(tape))
      throw new Error('Unknown native range endpoint');
    return found.index;
  }
  adjacent(marker: MarkerId, side: 'left' | 'right'): NativeCell {
    const binding = this.markers.get(resourceKey(marker));
    if (!binding) throw new Error('Unknown permanent marker');
    const cell = binding[side];
    if (!cell) throw new Error('Slot points outside permanent tape endpoints');
    this.onRead?.(cell.range);
    const native = this.nativeFor(binding.tape);
    return native ? nativeCell(native, cell.range) : cell;
  }
  range(range: RangeRef): readonly NativeCell[] {
    const cells = this.index(range.tape).range(range);
    countWork('cells.rangeCellsTraversed', cells.length);
    this.onRead?.(range);
    return this.cellsFor(cells);
  }
  tape(tape: TapeId): readonly NativeCell[] {
    const cells = this.index(tape).tape(tape);
    if (cells[0])
      this.onRead?.({ tape, start: cells[0].range.start, end: cells.at(-1)!.range.end });
    return this.cellsFor(cells);
  }
  containsBoundary(range: RangeRef, marker: MarkerId): boolean {
    const binding = this.markers.get(resourceKey(marker));
    if (!binding) throw new Error('Unknown permanent marker');
    return (
      resourceKey(binding.tape) === resourceKey(range.tape) &&
      this.index(range.tape).containsBoundary(range, marker)
    );
  }
  locateToken(tape: TapeId, id: NativeId): NativeCell {
    const native = this.nativeFor(tape),
      range = native && indexedNativeCell(native, tape, id);
    const cell = range ? this.index(tape).range(range)[0] : this.index(tape).locateToken(tape, id);
    this.onRead?.(cell.range);
    return native ? nativeCell(native, cell.range) : cell;
  }
  token(range: NativeTextRange): readonly NativeCell[] {
    const native = this.nativeFor(range.tape);
    if (native && hasIndexedNative(native)) {
      const cells = new Map<string, NativeCell>();
      for (const part of native.lookup(range)) {
        const cell = this.locateToken(range.tape, part.range);
        cells.set(cellKey(cell.range), cell);
      }
      return [...cells.values()].sort(
        (a, b) =>
          this.position(range.tape, a.range.start) - this.position(range.tape, b.range.start),
      );
    }
    const cells = this.index(range.tape).token(range);
    for (const cell of cells) this.onRead?.(cell.range);
    return this.cellsFor(cells);
  }
}
