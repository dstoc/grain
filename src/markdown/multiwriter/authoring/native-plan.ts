import type {
  Allocation,
  MarkerId,
  NativeId,
  NativeResourceBirth,
  NativeTextRange,
  RangeRef,
  TapeId,
} from '../contracts.js';
import type { NativeView } from '../ingest/publication.js';
import { resourceKey } from '../layout/index.js';
import type { LocatedText, NativeInsertion, TapePart, TapeSnapshot } from '../text/types.js';

/** Action-local native coordinate simulation. No Yjs clocks are consumed by planning. */
export class NativePlan implements NativeView {
  readonly operations: NativeInsertion[] = [];
  readonly allocations: Allocation[] = [];
  readonly manifest: NativeResourceBirth[] = [];
  private readonly tapes = new Map<string, TapeSnapshot>();
  private readonly client: number;
  private clock = 0;
  private readonly source?: { native: NativeView; tapes: readonly TapeId[] };
  constructor(
    input:
      | readonly TapeSnapshot[]
      | {
          native: NativeView;
          tapes: readonly TapeId[];
          clients: ReadonlySet<number>;
        },
  ) {
    const lazy = 'native' in input ? input : undefined;
    const snapshots = 'native' in input ? [] : input;
    this.source = lazy;
    const clients =
      lazy?.clients ?? new Set(snapshots.flatMap((s) => s.parts.map((p) => p.native.client)));
    let client = 0;
    while (clients.has(client)) client++;
    this.client = client;
    for (const s of structuredClone(snapshots)) this.tapes.set(resourceKey(s.tape), s);
  }
  all() {
    const result = new Map(this.source?.tapes.map((id) => [resourceKey(id), this.snapshot(id)]));
    for (const [key, snapshot] of this.tapes) result.set(key, structuredClone(snapshot));
    return [...result.values()];
  }
  snapshot(tape: TapeId): TapeSnapshot {
    let s = this.tapes.get(resourceKey(tape));
    if (!s && this.source) {
      s = this.source.native.snapshot(tape);
      this.tapes.set(resourceKey(tape), s);
    }
    if (!s) throw new Error('Unknown planned tape');
    return structuredClone(s);
  }
  marker(id: MarkerId) {
    for (const snapshot of this.tapes.values()) {
      const p = snapshot.parts.find(
        (p) => p.type === 'marker' && resourceKey(p.marker) === resourceKey(id),
      );
      if (p?.type === 'marker')
        return { tape: snapshot.tape, native: p.native, index: p.index, affinity: p.affinity };
    }
    if (this.source) {
      const found = this.source.native.marker(id);
      this.snapshot(found.tape);
      return found;
    }
    throw new Error('Unknown planned marker');
  }
  locate(tape: TapeId, id: NativeId): number {
    for (const part of this.snapshot(tape).parts) {
      const size = part.type === 'text' ? part.text.length : 1;
      if (
        part.native.client === id.client &&
        id.clock >= part.native.clock &&
        id.clock < part.native.clock + size
      )
        return part.index + id.clock - part.native.clock;
    }
    throw new Error('Unknown planned native identity');
  }
  lookup(range: NativeTextRange): readonly LocatedText[] {
    const result = this.snapshot(range.tape).parts.flatMap((p) => {
      if (p.type !== 'text' || p.native.client !== range.client) return [];
      const from = Math.max(p.native.clock, range.clock),
        to = Math.min(p.native.clock + p.text.length, range.clock + range.length);
      return from < to
        ? [
            {
              index: p.index + from - p.native.clock,
              text: p.text.slice(from - p.native.clock, to - p.native.clock),
              range: { ...range, clock: from, length: to - from },
            },
          ]
        : [];
    });
    if (result.reduce((n, p) => n + p.text.length, 0) !== range.length)
      throw new Error('Incomplete planned native range');
    return result;
  }
  range(range: RangeRef): readonly LocatedText[] {
    const start = this.marker(range.start),
      end = this.marker(range.end);
    if (
      resourceKey(start.tape) !== resourceKey(range.tape) ||
      resourceKey(end.tape) !== resourceKey(range.tape) ||
      start.index >= end.index
    )
      throw new Error('Invalid planned interval');
    return this.snapshot(range.tape).parts.flatMap((p) =>
      p.type === 'text' && p.index > start.index && p.index < end.index
        ? [
            {
              index: p.index,
              text: p.text,
              range: { tape: range.tape, ...p.native, length: p.text.length },
            },
          ]
        : [],
    );
  }
  encodeState(): Uint8Array {
    throw new Error('A native plan has no canonical bytes');
  }
  add(op: NativeInsertion): readonly NativeTextRange[] {
    if (op.type === 'text' && !op.text.length) return [];
    this.operations.push(structuredClone(op));
    if (op.type === 'createTape') {
      this.allocations.push({ type: 'tape', id: op.tape, start: op.start, end: op.end });
      this.tapes.set(resourceKey(op.tape), { tape: op.tape, length: 0, parts: [] });
      this.insert({ type: 'marker', tape: op.tape, index: 0, marker: op.start, affinity: 'left' });
      this.insert({ type: 'marker', tape: op.tape, index: 1, marker: op.end, affinity: 'right' });
      return [];
    }
    return this.insert(op);
  }
  private insert(op: Exclude<NativeInsertion, { type: 'createTape' }>): readonly NativeTextRange[] {
    const snapshot = this.snapshot(op.tape),
      size = op.type === 'text' ? op.text.length : 1;
    if (!Number.isInteger(op.index) || op.index < 0 || op.index > snapshot.length)
      throw new Error('Invalid planned insertion');
    const native = { client: this.client, clock: this.clock };
    this.clock += size;
    const parts: TapePart[] = snapshot.parts.flatMap((p) => {
      if (p.index >= op.index) return [{ ...p, index: p.index + size }];
      if (p.type === 'text' && p.index + p.text.length > op.index) {
        const cut = op.index - p.index;
        return [
          { ...p, text: p.text.slice(0, cut) },
          {
            ...p,
            index: op.index + size,
            native: { ...p.native, clock: p.native.clock + cut },
            text: p.text.slice(cut),
          },
        ];
      }
      return [p];
    });
    if (op.type === 'marker') {
      parts.push({ ...op, native });
      this.allocations.push({
        type: 'marker',
        id: op.marker,
        tape: op.tape,
        native,
        affinity: op.affinity,
      });
      this.manifest.push({ type: 'marker', tape: op.tape, marker: op.marker, native });
    } else {
      parts.push({ type: 'text', index: op.index, native, text: op.text });
      this.manifest.push({
        type: 'text',
        tape: op.tape,
        native: { ...native, length: size },
        text: op.text,
      });
    }
    parts.sort((a, b) => a.index - b.index);
    this.tapes.set(resourceKey(op.tape), { ...snapshot, length: snapshot.length + size, parts });
    return op.type === 'text' ? [{ tape: op.tape, ...native, length: size }] : [];
  }
  /** Bind by the planned final coordinates, including split/coalesced Yjs strings.
   * Text equality is an assertion; it never locates an origin by substring search.
   */
  bind(range: NativeTextRange, native: NativeView): readonly NativeTextRange[] {
    if (range.client !== this.client) return [structuredClone(range)];
    const snapshot = native.snapshot(range.tape);
    return [...this.lookup(range)]
      .sort((a, b) => a.range.clock - b.range.clock)
      .flatMap((p) => {
        const result = snapshot.parts.flatMap((part) => {
          if (part.type !== 'text') return [];
          const from = Math.max(part.index, p.index),
            to = Math.min(part.index + part.text.length, p.index + p.text.length);
          if (from >= to) return [];
          if (
            part.text.slice(from - part.index, to - part.index) !==
            p.text.slice(from - p.index, to - p.index)
          )
            throw new Error('Native binding text differs from planned coordinates');
          return [
            {
              tape: range.tape,
              client: part.native.client,
              clock: part.native.clock + from - part.index,
              length: to - from,
            },
          ];
        });
        if (result.reduce((n, r) => n + r.length, 0) !== p.text.length)
          throw new Error('Incomplete native binding');
        return result;
      });
  }
}
