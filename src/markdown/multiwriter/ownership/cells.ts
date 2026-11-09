import { OwnershipValidationError } from './errors.js';
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
import { countWork } from '../diagnostics.js';

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
  private readonly markers = new Map<string, { tape: TapeId; position: number; ordinal: number }>();

  private readonly native = new Map<
    string,
    Map<
      number,
      {
        readonly intervals: readonly {
          readonly start: number;
          readonly end: number;
          readonly cell: NativeCell;
        }[];
        readonly disjoint: boolean;
      }
    >
  >();

  constructor(snapshots: readonly TapeSnapshot[]) {
    countWork('cellIndex.snapshotsCloned', snapshots.length);
    countWork(
      'cellIndex.partsCloned',
      snapshots.reduce((n, s) => n + s.parts.length, 0),
    );
    const cells: NativeCell[] = [];
    for (const snapshot of structuredClone(snapshots)) {
      countWork('cellIndex.tapesIndexed');
      const key = resourceKey(snapshot.tape);
      if (this.tapes.has(key)) throw new OwnershipValidationError('Duplicate native tape snapshot');
      let previous: MarkerId | null = null;
      let fragments: LocatedText[] = [];
      const tapeCells: NativeCell[] = [];
      let position = 0;
      for (const part of snapshot.parts) {
        countWork('cellIndex.partsTraversed');
        if (part.index !== position)
          throw new OwnershipValidationError('Invalid native snapshot positions');
        if (part.type === 'marker') {
          const markerKey = resourceKey(part.marker);
          if (this.markers.has(markerKey))
            throw new OwnershipValidationError('Duplicate native marker');
          this.markers.set(markerKey, {
            tape: snapshot.tape,
            position,
            ordinal: tapeCells.length + Number(previous !== null),
          });
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
          if (!previous || !part.text.length)
            throw new OwnershipValidationError('Text outside native cells');
          fragments.push({
            index: position,
            text: part.text,
            range: { tape: snapshot.tape, ...part.native, length: part.text.length },
          });
          position += part.text.length;
        }
      }
      if (fragments.length || position !== snapshot.length || !tapeCells.length)
        throw new OwnershipValidationError('Missing permanent tape endpoints');
      const clients = new Map<number, { start: number; end: number; cell: NativeCell }[]>();
      for (const cell of tapeCells)
        for (const fragment of cell.fragments) {
          const { client, clock, length } = fragment.range;
          const intervals = clients.get(client) ?? [];
          intervals.push({ start: clock, end: clock + length, cell });
          clients.set(client, intervals);
        }
      this.native.set(
        key,
        new Map(
          [...clients].map(([client, intervals]) => {
            intervals.sort((a, b) => a.start - b.start);
            return [
              client,
              {
                intervals,
                disjoint: intervals.every((entry, i) => !i || intervals[i - 1].end <= entry.start),
              },
            ];
          }),
        ),
      );
      this.tapes.set(key, tapeCells);
      cells.push(...tapeCells);
    }
    this.cells = cells;
  }
  position(tape: TapeId, marker: MarkerId): number {
    const found = this.markers.get(resourceKey(marker));
    if (!found || !sameId(found.tape, tape))
      throw new OwnershipValidationError('Unknown native range endpoint');
    return found.position;
  }
  adjacent(boundary: MarkerId, side: 'left' | 'right'): NativeCell {
    const marker = this.markers.get(resourceKey(boundary));
    if (!marker) throw new OwnershipValidationError('Unknown permanent marker');
    const cell = this.tape(marker.tape).find((cell) =>
      sameId(side === 'left' ? cell.range.end : cell.range.start, boundary),
    );
    if (!cell) throw new OwnershipValidationError('Slot points outside permanent tape endpoints');
    return cell;
  }
  range(range: RangeRef): readonly NativeCell[] {
    const start = this.position(range.tape, range.start);
    const end = this.position(range.tape, range.end);
    if (start >= end) throw new OwnershipValidationError('Invalid open native range');
    return this.tape(range.tape).slice(
      this.markers.get(resourceKey(range.start))!.ordinal,
      this.markers.get(resourceKey(range.end))!.ordinal,
    );
  }
  tape(tape: TapeId): readonly NativeCell[] {
    const result = this.tapes.get(resourceKey(tape));
    if (!result) throw new OwnershipValidationError('Missing native tape snapshot');
    return result;
  }
  containsBoundary(range: RangeRef, boundary: MarkerId): boolean {
    const marker = this.markers.get(resourceKey(boundary));
    if (!marker) throw new OwnershipValidationError('Unknown permanent marker');
    if (!sameId(marker.tape, range.tape)) return false;
    const start = this.position(range.tape, range.start);
    const end = this.position(range.tape, range.end);
    if (start >= end) throw new OwnershipValidationError('Invalid open native range');
    return marker.position >= start && marker.position <= end;
  }
  locateToken(tape: TapeId, native: NativeId): NativeCell {
    if (
      !Number.isSafeInteger(native.client) ||
      native.client < 0 ||
      !Number.isSafeInteger(native.clock) ||
      native.clock < 0
    )
      throw new OwnershipValidationError('Invalid native text identity');
    const cells = this.tape(tape);
    const client = this.native.get(resourceKey(tape))!.get(native.client);
    let cell: NativeCell | undefined;
    if (client?.disjoint) {
      let low = 0,
        high = client.intervals.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (client.intervals[middle].start <= native.clock) low = middle + 1;
        else high = middle;
      }
      const interval = client.intervals[low - 1];
      if (interval && native.clock < interval.end) cell = interval.cell;
    } else if (client) {
      // Preserve first-cell lookup for overlapping diagnostic snapshots. Certified
      // native snapshots have disjoint clock intervals within each client.
      cell = cells.find((candidate) =>
        candidate.fragments.some(
          (fragment) =>
            fragment.range.client === native.client &&
            fragment.range.clock <= native.clock &&
            fragment.range.clock + fragment.range.length > native.clock,
        ),
      );
    }
    if (!cell) throw new OwnershipValidationError('Unknown native text identity');
    return cell;
  }
  token(range: NativeTextRange): readonly NativeCell[] {
    this.locateToken(range.tape, range);
    if (!Number.isSafeInteger(range.length) || range.length <= 0)
      throw new OwnershipValidationError('Invalid native text range');
    const client = this.native.get(resourceKey(range.tape))!.get(range.client)!;
    let cells: readonly NativeCell[];
    if (client.disjoint) {
      // Native clock order and tape order can differ after later insertions.
      // Select only overlapping clock intervals, then restore tape-cell order.
      const intervals = client.intervals;
      let low = 0,
        high = intervals.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (intervals[middle].end <= range.clock) low = middle + 1;
        else high = middle;
      }
      const selected = new Set<NativeCell>();
      for (
        let at = low;
        at < intervals.length && intervals[at].start < range.clock + range.length;
        at++
      )
        selected.add(intervals[at].cell);
      cells = [...selected].sort(
        (a, b) =>
          this.markers.get(resourceKey(a.range.start))!.ordinal -
          this.markers.get(resourceKey(b.range.start))!.ordinal,
      );
    } else {
      // Overlapping diagnostic snapshots keep the original duplicate/coverage
      // behavior. Certified native identity intervals are disjoint.
      cells = this.tape(range.tape).filter((cell) =>
        cell.fragments.some(
          (fragment) =>
            fragment.range.client === range.client &&
            fragment.range.clock < range.clock + range.length &&
            fragment.range.clock + fragment.range.length > range.clock,
        ),
      );
    }
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
            throw new OwnershipValidationError('Native text range splits a surrogate pair');
        }
        covered += end - start;
      }
    if (covered !== range.length)
      throw new OwnershipValidationError('Unknown native text identity');
    return cells;
  }
}
export function assignmentKey(assignment: Pick<CellAssignment, 'run' | 'occurrence'>): string {
  return JSON.stringify([resourceKey(assignment.run), resourceKey(assignment.occurrence)]);
}
