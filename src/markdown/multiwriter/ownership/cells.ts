import type {
  CellAssignment,
  MarkerId,
  NativeId,
  NativeTextRange,
  RangeRef,
  TapeId,
} from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import type { BoundaryIndex } from '../layout/index.js';
import type { TapeSnapshot } from '../text/cache.js';
import type { LocatedText } from '../text/types.js';

export interface NativeCell {
  readonly range: RangeRef;
  readonly fragments: readonly LocatedText[];
}
export function cellKey(range: RangeRef): string {
  return JSON.stringify([
    resourceKey(range.tape),
    resourceKey(range.start),
    resourceKey(range.end),
  ]);
}
export function sameId(
  a: Parameters<typeof resourceKey>[0],
  b: Parameters<typeof resourceKey>[0],
): boolean {
  return resourceKey(a) === resourceKey(b);
}

/** Disposable index over one complete ready native closure. No native writes. */
export class CellIndex implements BoundaryIndex {
  readonly cells: readonly NativeCell[];
  private readonly tapes = new Map<string, readonly NativeCell[]>();
  private readonly markers = new Map<string, { tape: TapeId; position: number }>();

  constructor(snapshots: readonly TapeSnapshot[]) {
    const cells: NativeCell[] = [];
    for (const snapshot of structuredClone(snapshots)) {
      const key = resourceKey(snapshot.tape);
      if (this.tapes.has(key)) throw new Error('Duplicate native tape snapshot');
      let previous: MarkerId | null = null;
      let fragments: LocatedText[] = [];
      const tapeCells: NativeCell[] = [];
      let position = 0;
      for (const part of snapshot.parts) {
        if (part.index !== position) throw new Error('Invalid native snapshot positions');
        if (part.type === 'marker') {
          const markerKey = resourceKey(part.marker);
          if (this.markers.has(markerKey)) throw new Error('Duplicate native marker');
          this.markers.set(markerKey, { tape: snapshot.tape, position });
          if (previous) {
            tapeCells.push({
              range: { tape: snapshot.tape, start: previous, end: part.marker },
              fragments,
            });
          }
          previous = part.marker;
          fragments = [];
          position++;
        } else {
          if (!previous || !part.text.length) throw new Error('Text outside native cells');
          fragments.push({
            index: position,
            text: part.text,
            range: { tape: snapshot.tape, ...part.native, length: part.text.length },
          });
          position += part.text.length;
        }
      }
      if (fragments.length || position !== snapshot.length || !tapeCells.length)
        throw new Error('Missing permanent tape endpoints');
      this.tapes.set(key, tapeCells);
      cells.push(...tapeCells);
    }
    this.cells = cells;
  }
  position(tape: TapeId, marker: MarkerId): number {
    const found = this.markers.get(resourceKey(marker));
    if (!found || !sameId(found.tape, tape)) throw new Error('Unknown native range endpoint');
    return found.position;
  }
  range(range: RangeRef): readonly NativeCell[] {
    const start = this.position(range.tape, range.start);
    const end = this.position(range.tape, range.end);
    if (start >= end) throw new Error('Invalid open native range');
    return this.tape(range.tape).filter(
      (cell) =>
        this.position(range.tape, cell.range.start) >= start &&
        this.position(range.tape, cell.range.end) <= end,
    );
  }
  tape(tape: TapeId): readonly NativeCell[] {
    const result = this.tapes.get(resourceKey(tape));
    if (!result) throw new Error('Missing native tape snapshot');
    return result;
  }
  containsBoundary(range: RangeRef, boundary: MarkerId): boolean {
    const marker = this.markers.get(resourceKey(boundary));
    if (!marker) throw new Error('Unknown permanent marker');
    if (!sameId(marker.tape, range.tape)) return false;
    const start = this.position(range.tape, range.start);
    const end = this.position(range.tape, range.end);
    if (start >= end) throw new Error('Invalid open native range');
    return marker.position >= start && marker.position <= end;
  }
  locateToken(tape: TapeId, native: NativeId): NativeCell {
    if (
      !Number.isSafeInteger(native.client) ||
      native.client < 0 ||
      !Number.isSafeInteger(native.clock) ||
      native.clock < 0
    )
      throw new Error('Invalid native text identity');
    const cell = this.tape(tape).find((cell) =>
      cell.fragments.some(
        (fragment) =>
          fragment.range.client === native.client &&
          fragment.range.clock <= native.clock &&
          fragment.range.clock + fragment.range.length > native.clock,
      ),
    );
    if (!cell) throw new Error('Unknown native text identity');
    return cell;
  }
  token(range: NativeTextRange): readonly NativeCell[] {
    this.locateToken(range.tape, range);
    if (!Number.isSafeInteger(range.length) || range.length <= 0)
      throw new Error('Invalid native text range');
    const cells = this.tape(range.tape).filter((cell) =>
      cell.fragments.some(
        (fragment) =>
          fragment.range.client === range.client &&
          fragment.range.clock < range.clock + range.length &&
          fragment.range.clock + fragment.range.length > range.clock,
      ),
    );
    let covered = 0;
    for (const cell of cells)
      for (const fragment of cell.fragments) {
        if (fragment.range.client !== range.client) continue;
        const start = Math.max(range.clock, fragment.range.clock);
        const end = Math.min(
          range.clock + range.length,
          fragment.range.clock + fragment.range.length,
        );
        if (start >= end) continue;
        for (const offset of [start - fragment.range.clock, end - fragment.range.clock]) {
          const before = fragment.text.charCodeAt(offset - 1);
          const after = fragment.text.charCodeAt(offset);
          if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
            throw new Error('Native text range splits a surrogate pair');
        }
        covered += end - start;
      }
    if (covered !== range.length) throw new Error('Unknown native text identity');
    return cells;
  }
}
export function assignmentKey(assignment: Pick<CellAssignment, 'run' | 'occurrence'>): string {
  return JSON.stringify([resourceKey(assignment.run), resourceKey(assignment.occurrence)]);
}
