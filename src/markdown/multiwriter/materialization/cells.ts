import { CellIndex } from '../ownership/cells.js';
import type { NativeCell } from '../ownership/cells.js';
import type { MarkerId, NativeId, NativeTextRange, RangeRef, TapeId } from '../contracts.js';
import type { TapeSnapshot } from '../text/types.js';
import { resourceKey } from '../layout/index.js';
import { PersistentMap } from './map.js';

/** Immutable tape-local cell roots. Refinement replaces only affected tape indexes. */
export class MaterializedCells {
  private tapes = new PersistentMap<CellIndex>();
  private markers = new PersistentMap<TapeId>();
  constructor(
    snapshots: readonly TapeSnapshot[],
    private readonly onRead?: (range: RangeRef) => void,
  ) {
    this.install(snapshots);
  }
  /** A replay-local facade records semantic reads without changing published roots. */
  observing(onRead: (range: RangeRef) => void): MaterializedCells {
    const copy = new MaterializedCells([], onRead);
    copy.tapes = this.tapes;
    copy.markers = this.markers;
    return copy;
  }
  refine(snapshots: readonly TapeSnapshot[]): MaterializedCells {
    const copy = new MaterializedCells([]);
    copy.tapes = this.tapes.fork();
    copy.markers = this.markers.fork();
    copy.install(snapshots);
    return copy;
  }
  private install(snapshots: readonly TapeSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.tapes.set(resourceKey(snapshot.tape), new CellIndex([snapshot]));
      for (const part of snapshot.parts)
        if (part.type === 'marker' && !this.markers.has(resourceKey(part.marker)))
          this.markers.set(resourceKey(part.marker), snapshot.tape);
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
      return cells;
    });
  }
  // Retained marker order is checked before reuse. Position/membership queries
  // alone do not depend on new cells; range/adjacency/token reads do.
  position(tape: TapeId, marker: MarkerId): number {
    return this.index(tape).position(tape, marker);
  }
  adjacent(marker: MarkerId, side: 'left' | 'right'): NativeCell {
    const tape = this.markers.get(resourceKey(marker));
    if (!tape) throw new Error('Unknown permanent marker');
    const cell = this.index(tape).adjacent(marker, side);
    this.onRead?.(cell.range);
    return cell;
  }
  range(range: RangeRef): readonly NativeCell[] {
    const cells = this.index(range.tape).range(range);
    this.onRead?.(range);
    return cells;
  }
  tape(tape: TapeId): readonly NativeCell[] {
    const cells = this.index(tape).tape(tape);
    if (cells[0])
      this.onRead?.({ tape, start: cells[0].range.start, end: cells.at(-1)!.range.end });
    return cells;
  }
  containsBoundary(range: RangeRef, marker: MarkerId): boolean {
    const tape = this.markers.get(resourceKey(marker));
    if (!tape) throw new Error('Unknown permanent marker');
    return (
      resourceKey(tape) === resourceKey(range.tape) &&
      this.index(range.tape).containsBoundary(range, marker)
    );
  }
  locateToken(tape: TapeId, id: NativeId): NativeCell {
    const cell = this.index(tape).locateToken(tape, id);
    this.onRead?.(cell.range);
    return cell;
  }
  token(range: NativeTextRange): readonly NativeCell[] {
    const cells = this.index(range.tape).token(range);
    for (const cell of cells) this.onRead?.(cell.range);
    return cells;
  }
}
