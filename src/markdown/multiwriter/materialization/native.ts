import * as Y from 'yjs';
import type { MarkerId, NativeId, NativeTextRange, RangeRef, TapeId } from '../contracts.js';
import type { NativeView } from '../ingest/publication.js';
import type { Work } from '../ingest/work.js';
import { NativeTapeCache } from '../text/cache.js';
import {
  assertNative,
  assertTextBoundary,
  NativeValidationError,
  resourceKey,
} from '../text/identity.js';
import type { LocatedText, NativeBody, TapePart, TapeSnapshot } from '../text/types.js';
import { registerNativePlanSource } from '../authoring/native-plan.js';
import { PersistentMap } from './map.js';
import { get, set } from './map.js';
import type { MapRoot } from './map.js';

interface TapeIndex {
  readonly snapshot: TapeSnapshot;
  readonly native: readonly TapePart[];
  readonly markers: ReadonlyMap<string, Extract<TapePart, { type: 'marker' }>>;
}
interface BodyLink {
  readonly previous?: BodyLink;
  readonly updates: readonly Uint8Array[];
  readonly tapes: readonly TapeId[];
}
const nativeRoots = new WeakMap<NativeView, BodyLink | undefined>();
/** Changes between two views of the same monotonically integrated private cache.
 * A rebuilt/evicted native branch has no reusable prefix and returns undefined.
 */
export function changedNativeTapes(
  before: NativeView,
  after: NativeView,
): readonly TapeId[] | undefined {
  if (!nativeRoots.has(before) || !nativeRoots.has(after)) return undefined;
  const stop = nativeRoots.get(before),
    touched = new Map<string, TapeId>();
  let link = nativeRoots.get(after);
  while (link !== stop) {
    if (!link) return undefined;
    for (const tape of link.tapes) touched.set(resourceKey(tape), tape);
    link = link.previous;
  }
  return [...touched.values()];
}
export interface NativeWork {
  bodiesIntegrated: number;
  tapesIndexed: number;
  partsIndexed: number;
  markerBindingsIndexed: number;
}
const compareNative = (a: NativeId, b: NativeId) => a.client - b.client || a.clock - b.clock;

/** A read view owns immutable tape roots, never a facade bound to a mutable Y.Doc. */
function readView(
  tapes: MapRoot<TapeIndex> | undefined,
  markerTapes: MapRoot<TapeId> | undefined,
  bodies: BodyLink | undefined,
  tapeIds: PersistentMap<TapeId>,
  clients: MapRoot<true> | undefined,
): NativeView {
  const tapeIndex = (id: TapeId) => {
    const tape = get(tapes, resourceKey(id));
    if (!tape) throw new NativeValidationError('Unknown native tape');
    return tape;
  };
  function partAt(tape: TapeIndex, id: NativeId): TapePart {
    assertNative(id);
    const parts = tape.native;
    let low = 0,
      high = parts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareNative(parts[mid].native, id) <= 0) low = mid + 1;
      else high = mid;
    }
    const part = parts[low - 1];
    if (
      !part ||
      part.native.client !== id.client ||
      id.clock >= part.native.clock + (part.type === 'text' ? part.text.length : 1)
    )
      throw new NativeValidationError('Unknown native ID');
    if (part.type === 'text') assertTextBoundary(part.text, id.clock - part.native.clock);
    return part;
  }
  function marker(id: MarkerId) {
    const tape = get(markerTapes, resourceKey(id));
    const part = tape && tapeIndex(tape).markers.get(resourceKey(id));
    if (!tape || !part) throw new NativeValidationError('Unknown permanent marker');
    return structuredClone({
      tape,
      native: part.native,
      index: part.index,
      affinity: part.affinity,
    });
  }
  const view: NativeView = {
    snapshot: (id) => structuredClone(tapeIndex(id).snapshot),
    marker,
    locate(tape, id) {
      const part = partAt(tapeIndex(tape), id);
      return part.index + id.clock - part.native.clock;
    },
    range(ref: RangeRef): readonly LocatedText[] {
      const start = marker(ref.start),
        end = marker(ref.end);
      if (
        resourceKey(start.tape) !== resourceKey(ref.tape) ||
        resourceKey(end.tape) !== resourceKey(ref.tape) ||
        start.index >= end.index
      )
        throw new NativeValidationError('Invalid open native range');
      return tapeIndex(ref.tape).snapshot.parts.flatMap((part) =>
        part.type === 'text' && part.index > start.index && part.index < end.index
          ? [
              {
                index: part.index,
                text: part.text,
                range: {
                  tape: structuredClone(ref.tape),
                  ...part.native,
                  length: part.text.length,
                },
              },
            ]
          : [],
      );
    },
    lookup(range: NativeTextRange): readonly LocatedText[] {
      assertNative(range, range.length);
      const tape = tapeIndex(range.tape),
        result: LocatedText[] = [];
      let clock = range.clock;
      const end = clock + range.length;
      while (clock < end) {
        const part = partAt(tape, { client: range.client, clock });
        if (part.type !== 'text') throw new NativeValidationError('Text range includes a marker');
        const from = clock - part.native.clock;
        const length = Math.min(end - clock, part.text.length - from);
        assertTextBoundary(part.text, from + length);
        result.push({
          index: part.index + from,
          text: part.text.slice(from, from + length),
          range: { ...structuredClone(range), clock, length },
        });
        clock += length;
      }
      return result;
    },
    // Diagnostics deliberately pay for exact reconstruction. This is not ordinary input work.
    encodeState() {
      const doc = new Y.Doc({ gc: false });
      try {
        const links: BodyLink[] = [];
        for (let link = bodies; link; link = link.previous) links.push(link);
        for (let i = links.length - 1; i >= 0; i--)
          for (const update of links[i].updates) Y.applyUpdate(doc, update);
        return Y.encodeStateAsUpdate(doc);
      } finally {
        doc.destroy();
      }
    },
  };
  nativeRoots.set(view, bodies);
  registerNativePlanSource(view, {
    native: view,
    get tapes() {
      return structuredClone([...tapeIds.values()]);
    },
    clients: { has: (client) => get(clients, String(client)) === true },
  });
  return view;
}

/** Monotone private native integration with tape-local copy-on-write read roots.
 * A publication may keep any previous view during preparation, cancellation or withdrawal.
 * Whole touched tapes are indexed for now; this does not claim interval-local text work.
 */
export class MaterializedNative {
  private cache: NativeTapeCache;
  private tapes?: MapRoot<TapeIndex>;
  private markerTapes?: MapRoot<TapeId>;
  private bodies?: BodyLink;
  private clients?: MapRoot<true>;
  private tapeIds = new PersistentMap<TapeId>();
  private damaged = false;
  readonly work: NativeWork = {
    bodiesIntegrated: 0,
    tapesIndexed: 0,
    partsIndexed: 0,
    markerBindingsIndexed: 0,
  };
  constructor(decodeOperations: number) {
    this.cache = new NativeTapeCache(decodeOperations);
  }
  view(): NativeView {
    return readView(this.tapes, this.markerTapes, this.bodies, this.tapeIds, this.clients);
  }
  *apply(key: string, input: NativeBody): Work<void> {
    if (this.damaged) throw new Error('Cancelled native indexing requires a fresh materializer');
    // Own the native subset before the first yield. Callers cannot change the
    // tape frontier while native validation is suspended. Do not retain copies
    // of semantic effects/dependencies in this disposable cache.
    const body = structuredClone({
      allocations: input.allocations.filter(
        (entry) => entry.type === 'tape' || entry.type === 'marker',
      ),
      nativeInsertUpdates: input.nativeInsertUpdates,
      nativeManifest: input.nativeManifest,
    });
    let committed = false;
    try {
      yield* this.cache.applySteps(key, body);
      const touched = new Map<string, TapeId>();
      for (const entry of body.nativeManifest) touched.set(resourceKey(entry.tape), entry.tape);
      for (const entry of body.allocations)
        if (entry.type === 'tape') touched.set(resourceKey(entry.id), entry.id);
      let tapes = this.tapes,
        markers = this.markerTapes;
      for (const [name, id] of touched) {
        const snapshot = yield* this.cache.snapshotSteps(id);
        const index: TapeIndex = {
          snapshot,
          native: [...snapshot.parts].sort((a, b) => compareNative(a.native, b.native)),
          markers: new Map(
            snapshot.parts.flatMap((part) =>
              part.type === 'marker' ? [[resourceKey(part.marker), part] as const] : [],
            ),
          ),
        };
        tapes = set(tapes, name, index);

        this.work.tapesIndexed++;
        this.work.partsIndexed += snapshot.parts.length;
      }
      // Permanent marker-to-tape bindings never change after allocation. The tape
      // root above carries current positions; update only newly allocated bindings.
      for (const allocation of body.allocations)
        if (allocation.type === 'marker') {
          markers = set(markers, resourceKey(allocation.id), allocation.tape);
          this.work.markerBindingsIndexed++;
        }
      this.tapes = tapes;
      this.markerTapes = markers;
      const tapeIds = this.tapeIds.fork();
      for (const allocation of body.allocations)
        if (allocation.type === 'tape') tapeIds.set(resourceKey(allocation.id), allocation.id);
      this.tapeIds = tapeIds;
      for (const birth of body.nativeManifest)
        this.clients = set(this.clients, String(birth.native.client), true);
      this.bodies = {
        previous: this.bodies,
        updates: body.nativeInsertUpdates,
        tapes: [...touched.values()],
      };
      this.work.bodiesIntegrated++;
      committed = true;
    } finally {
      // The underlying cache can have advanced before a yielded index is cancelled.
      // Its unpublished roots are never reused after that interruption.
      if (!committed) this.damaged = true;
    }
  }
  destroy(): void {
    this.cache.destroy();
  }
}
