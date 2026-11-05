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
  constructor(snapshots: readonly TapeSnapshot[]) {
    this.install(snapshots);
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
    return [...this.tapes.values()].flatMap((index) => index.cells);
  }
  position(tape: TapeId, marker: MarkerId): number {
    return this.index(tape).position(tape, marker);
  }
  adjacent(marker: MarkerId, side: 'left' | 'right'): NativeCell {
    const tape = this.markers.get(resourceKey(marker));
    if (!tape) throw new Error('Unknown permanent marker');
    return this.index(tape).adjacent(marker, side);
  }
  range(range: RangeRef): readonly NativeCell[] {
    return this.index(range.tape).range(range);
  }
  tape(tape: TapeId): readonly NativeCell[] {
    return this.index(tape).tape(tape);
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
    return this.index(tape).locateToken(tape, id);
  }
  token(range: NativeTextRange): readonly NativeCell[] {
    return this.index(range.tape).token(range);
  }
}
