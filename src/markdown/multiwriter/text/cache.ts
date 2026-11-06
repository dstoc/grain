import { countWork } from '../diagnostics.js';
import { measure } from '../diagnostics.js';
import { DEFAULT_INGEST_LIMITS, assertLimit, finish } from '../ingest/work.js';
import type { Work } from '../ingest/work.js';
import * as Y from 'yjs';
import type { MarkerId, NativeId, NativeTextRange, RangeRef, TapeId } from '../contracts.js';
import type {
  LocatedText,
  MarkerAllocation,
  NativeBody,
  NativeInsertion,
  PreparedNativeBody,
  TapeAllocation,
  TapePart,
  TapeSnapshot,
} from './types.js';
import {
  NativeValidationError,
  assertNative,
  assertTextBoundary,
  assertUnicode,
  resourceKey,
} from './identity.js';
import { inspectBody, inspectBodySteps } from './validate.js';
export type {
  NativeBody,
  NativeInsertion,
  PreparedNativeBody,
  TapePart,
  TapeSnapshot,
} from './types.js';

/**
 * Private, insertion-only Yjs cache. Never attach a provider or expose the Doc/Text objects.
 * The action store owns readiness, causal-base validation, forks and publication. Pass only
 * ready native bodies here, using the same stable key for a genesis/action on every replay.
 * Visibility, deletion, undo and ownership are deliberately outside this class.
 */
export class NativeTapeCache {
  #doc = new Y.Doc({ gc: false });
  #tapes = new Map<string, TapeAllocation>();
  #markers = new Map<string, MarkerAllocation>();
  #retained = new Map<string, NativeBody>();
  #pending: object | null = null;
  #closed = false;
  #decodeOperations: number;
  #positions = new WeakMap<Y.Text, WeakMap<Y.Item, number>>();

  constructor(decodeOperations = DEFAULT_INGEST_LIMITS.decodeOperations as number) {
    assertLimit(decodeOperations);
    this.#decodeOperations = decodeOperations;
  }

  /** Diagnostic identity only; no Yjs object or synchronization interface escapes. */
  get clientId(): number {
    return this.#doc.clientID;
  }

  /**
   * Capture just this action's update events on the stable native client. Reads then reflect
   * staged content; publish projection only after envelope append. Commit or abort before
   * the next write. This synchronous publication boundary is not a session admission lock.
   */
  prepare(key: string, insertions: readonly NativeInsertion[]): PreparedNativeBody {
    return measure('native-preparation', () => this.prepareMeasured(key, insertions));
  }
  private prepareMeasured(key: string, insertions: readonly NativeInsertion[]): PreparedNativeBody {
    this.#idle();
    if (!key || this.#retained.has(key))
      throw new Error('Native body key already published/invalid');
    const token = {};
    this.#pending = token;
    const allocations: (TapeAllocation | MarkerAllocation)[] = [];
    const updates: Uint8Array[] = [];
    const origin = {};
    const capture = (update: Uint8Array, eventOrigin: unknown) => {
      if (eventOrigin !== origin) throw new Error('Unexpected native writer');
      updates.push(update.slice());
    };
    this.#doc.on('update', capture);
    let body: NativeBody;
    try {
      // One native transaction per semantic action. Offsets in later operations include earlier inserts.
      this.#doc.transact(() => {
        for (const insertion of structuredClone(insertions)) {
          if (insertion.type === 'createTape') {
            const name = resourceKey(insertion.tape);
            if (this.#tapes.has(name)) throw new Error('Tape already exists');
            if (insertion.tape.kind !== 'tape') throw new Error('Invalid tape ID');
            const tape: TapeAllocation = {
              type: 'tape',
              id: insertion.tape,
              start: insertion.start,
              end: insertion.end,
            };
            this.#tapes.set(name, tape);
            allocations.push(tape);
            this.#insertMarker(insertion.tape, 0, insertion.start, 'left', allocations);
            this.#insertMarker(insertion.tape, 1, insertion.end, 'right', allocations);
          } else {
            const tape = this.#text(insertion.tape);
            this.#assertInsertion(tape, insertion.index);
            if (insertion.type === 'text') {
              assertUnicode(insertion.text);
              if (insertion.text.length) {
                this.#positions.delete(tape);
                tape.insert(insertion.index, insertion.text);
              }
            } else
              this.#insertMarker(
                insertion.tape,
                insertion.index,
                insertion.marker,
                insertion.affinity,
                allocations,
              );
          }
        }
      }, origin);
      const manifest = updates.flatMap((update) =>
        Y.decodeUpdate(update).structs.map((struct) => {
          if (!(struct instanceof Y.Item)) throw new Error('Unexpected native struct');
          const integrated = Y.getItem(this.#doc.store, struct.id);
          const tape = this.#tapes.get(Y.findRootTypeKey(integrated.parent as Y.Text))!.id;
          const native = { client: struct.id.client, clock: struct.id.clock };
          if (struct.content instanceof Y.ContentString)
            return {
              type: 'text' as const,
              tape,
              native: { ...native, length: struct.length },
              text: struct.content.str,
            };
          const { grainMarker } = (struct.content as Y.ContentEmbed).embed as {
            grainMarker: string;
          };
          const marker = this.#markers.get(grainMarker)!;
          return { type: 'marker' as const, tape, native, marker: marker.id };
        }),
      );
      body = { allocations, nativeInsertUpdates: updates, nativeManifest: manifest };
      // Validate against the registry before this action, not its provisional allocations.
      const newTapes = new Set(
        allocations.filter((a) => a.type === 'tape').map((a) => resourceKey(a.id)),
      );
      const newMarkers = new Set(
        allocations.filter((a) => a.type === 'marker').map((a) => resourceKey(a.id)),
      );
      const inspection = inspectBody(
        this.#doc,
        {
          tapes: excluding(this.#tapes, newTapes),
          markers: excluding(this.#markers, newMarkers),
        },
        body,
        true,
        this.#decodeOperations,
      );
      this.#assertSettled(inspection.touched);
    } catch (error) {
      this.#doc.off('update', capture);
      this.#recover();
      throw error;
    } finally {
      this.#doc.off('update', capture);
    }
    const retained = copyBody(body);
    const checkToken = () => {
      if (this.#pending !== token) throw new Error('Native preparation is no longer current');
    };
    return {
      body: copyBody(retained),
      commit: () => {
        checkToken();
        this.#retained.set(key, retained);
        this.#pending = null;
      },
      abort: () => {
        checkToken();
        this.#recover();
      },
    };
  }

  /** Apply a complete ready body. An identical repeat is idempotent; changed bytes are an error. */
  apply(key: string, input: NativeBody): void {
    return measure('native-preparation', () => {
      finish(this.applySteps(key, input));
    });
  }

  /** Stages validation across slices; no native mutation occurs until inspection completes. */
  *applySteps(key: string, input: NativeBody): Work<void> {
    this.#idle();
    if (!key) throw new Error('Invalid native body key');
    const body = copyBody(input);
    const previous = this.#retained.get(key);
    if (previous) {
      if (!sameBody(previous, body)) throw new Error('Conflicting native body key');
      return;
    }
    // Decode and reject forbidden writes before mutation. Post-integration failure also rebuilds.
    const token = {};
    this.#pending = token;
    try {
      const inspection = yield* inspectBodySteps(
        this.#doc,
        { tapes: this.#tapes, markers: this.#markers },
        body,
        false,
        this.#decodeOperations,
      );
      if (this.#pending !== token || this.#closed) throw new Error('Native inspection invalidated');
      try {
        for (const tape of inspection.tapes) {
          this.#tapes.set(resourceKey(tape.id), tape);
          this.#doc.getText(resourceKey(tape.id));
        }
        for (const marker of inspection.markers) this.#markers.set(resourceKey(marker.id), marker);
        for (const name of inspection.touched) this.#positions.delete(this.#doc.getText(name));
        for (const update of body.nativeInsertUpdates) Y.applyUpdate(this.#doc, update);
        this.#assertSettled(inspection.touched);
        this.#retained.set(key, body);
      } catch (error) {
        this.#recover();
        throw error;
      }
    } finally {
      if (this.#pending === token) this.#pending = null;
    }
  }

  /** Replace a contaminated/evicted cache with the caller's exact ready closure in causal order. */
  rebuild(ready: readonly { readonly key: string; readonly body: NativeBody }[]): void {
    this.#open();
    const candidate = new NativeTapeCache(this.#decodeOperations);
    try {
      for (const entry of ready) candidate.apply(entry.key, entry.body);
    } catch (error) {
      candidate.destroy();
      throw error;
    }
    const old = this.#doc;
    this.#doc = candidate.#doc;
    this.#positions = new WeakMap();
    this.#tapes = candidate.#tapes;
    this.#markers = candidate.#markers;
    this.#retained = candidate.#retained;
    this.#pending = null;
    this.#freshClient(old.clientID);
    old.destroy();
  }

  snapshot(tape: TapeId): TapeSnapshot {
    return finish(this.snapshotSteps(tape));
  }

  *snapshotSteps(tape: TapeId): Work<TapeSnapshot> {
    this.#open();
    const text = this.#text(tape);
    const parts: TapePart[] = [];
    let index = 0;
    for (let item = text._start; item; item = item.right) {
      countWork('native.snapshotItemsTraversed');
      yield;
      const native = { client: item.id.client, clock: item.id.clock };
      if (item.content instanceof Y.ContentString)
        parts.push({ type: 'text', index, native, text: item.content.str });
      else {
        const marker = this.#markers.get(
          ((item.content as Y.ContentEmbed).embed as { grainMarker: string }).grainMarker,
        )!;
        parts.push({ type: 'marker', index, native, marker: marker.id, affinity: marker.affinity });
      }
      index += item.length;
    }
    countWork('native.snapshotPartsCloned', parts.length);
    return structuredClone({ tape, length: index, parts });
  }

  /** Final integrated items intersecting the admitted insertions. An item can
   * include retained text after Yjs merges adjacent structs. Insertion-only
   * callers can splice these items into their own immutable indexes; splitting
   * an old item around a new insertion is implied by that splice.
   */
  *affectedPartsSteps(manifest: NativeBody['nativeManifest']): Work<
    readonly {
      readonly tape: TapeId;
      readonly part: TapePart;
    }[]
  > {
    this.#open();
    const parts = new Map<string, { readonly tape: TapeId; readonly part: TapePart }>();
    for (const entry of manifest) {
      let clock = entry.native.clock;
      const end = clock + (entry.type === 'text' ? entry.native.length : 1);
      while (clock < end) {
        yield;
        const item = Y.getItem(this.#doc.store, Y.createID(entry.native.client, clock));
        if (item.parent !== this.#text(entry.tape))
          throw new NativeValidationError('Native ID belongs to another tape');
        const key = `${item.id.client}:${item.id.clock}`;
        if (!parts.has(key)) {
          const native = { client: item.id.client, clock: item.id.clock },
            index = yield* this.locateSteps(entry.tape, native);
          let part: TapePart;
          if (item.content instanceof Y.ContentString)
            part = { type: 'text', index, native, text: item.content.str };
          else {
            const marker = this.#markers.get(
              ((item.content as Y.ContentEmbed).embed as { grainMarker: string }).grainMarker,
            )!;
            part = { type: 'marker', index, native, marker: marker.id, affinity: marker.affinity };
          }
          parts.set(key, { tape: entry.tape, part });
        }
        clock = item.id.clock + item.length;
      }
    }
    return structuredClone([...parts.values()]);
  }

  /** Permanent open interval. Interior markers refine cells but are not returned as text. */
  range(ref: RangeRef): readonly LocatedText[] {
    const start = this.marker(ref.start);
    const end = this.marker(ref.end);
    if (
      resourceKey(start.tape) !== resourceKey(ref.tape) ||
      resourceKey(end.tape) !== resourceKey(ref.tape) ||
      start.index >= end.index
    )
      throw new NativeValidationError('Invalid open native range');
    return this.snapshot(ref.tape).parts.flatMap((part) =>
      part.type === 'text' && part.index > start.index && part.index < end.index
        ? [
            {
              index: part.index,
              text: part.text,
              range: { tape: structuredClone(ref.tape), ...part.native, length: part.text.length },
            },
          ]
        : [],
    );
  }

  marker(id: MarkerId): {
    readonly tape: TapeId;
    readonly native: NativeId;
    readonly index: number;
    readonly affinity: 'left' | 'right';
  } {
    return finish(this.markerSteps(id));
  }

  *markerSteps(id: MarkerId): Work<{
    readonly tape: TapeId;
    readonly native: NativeId;
    readonly index: number;
    readonly affinity: 'left' | 'right';
  }> {
    this.#open();
    const allocation = this.#markers.get(resourceKey(id));
    if (!allocation) throw new NativeValidationError('Unknown permanent marker');
    const position = yield* this.locateSteps(allocation.tape, allocation.native);
    return structuredClone({
      tape: allocation.tape,
      native: allocation.native,
      index: position,
      affinity: allocation.affinity,
    });
  }

  locate(tape: TapeId, id: NativeId): number {
    return finish(this.locateSteps(tape, id));
  }

  *locateSteps(tape: TapeId, id: NativeId): Work<number> {
    this.#open();
    assertNative(id);
    if (id.clock >= Y.getState(this.#doc.store, id.client))
      throw new NativeValidationError('Unknown native ID');
    const item = Y.getItem(this.#doc.store, Y.createID(id.client, id.clock));
    if (item.parent !== this.#text(tape))
      throw new NativeValidationError('Native ID belongs to another tape');
    // The offset itself must address a whole Unicode character or an embed.
    const offset = id.clock - item.id.clock;
    if (item.content instanceof Y.ContentString) assertTextBoundary(item.content.str, offset);
    const text = item.parent as Y.Text;
    let positions = this.#positions.get(text);
    if (!positions) {
      positions = new WeakMap();
      this.#positions.set(text, positions);
    }
    const path: Y.Item[] = [];
    let cursor: Y.Item | null = item;
    while (cursor && !positions.has(cursor)) {
      yield;
      if (this.#positions.get(text) !== positions) throw new Error('Native lookup invalidated');
      path.push(cursor);
      cursor = cursor.left;
    }
    let index = cursor ? positions.get(cursor)! + cursor.length : 0;
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i];
      positions.set(entry, index);
      index += entry.length;
    }
    return positions.get(item)! + offset;
  }

  /** Exact observed IDs. Concurrent insertions inside the native interval are excluded. */
  lookup(range: NativeTextRange): readonly LocatedText[] {
    return finish(this.lookupSteps(range));
  }

  *lookupSteps(range: NativeTextRange): Work<readonly LocatedText[]> {
    this.#open();
    assertNative(range, range.length);
    const result: LocatedText[] = [];
    let clock = range.clock;
    const end = clock + range.length;
    while (clock < end) {
      yield;
      const id = { client: range.client, clock };
      const index = yield* this.locateSteps(range.tape, id);
      const item = Y.getItem(this.#doc.store, Y.createID(range.client, clock));
      if (!(item.content instanceof Y.ContentString))
        throw new NativeValidationError('Text range includes a marker');
      const from = clock - item.id.clock;
      const length = Math.min(end - clock, item.length - from);
      assertTextBoundary(item.content.str, from + length);
      result.push({
        index,
        text: item.content.str.slice(from, from + length),
        range: { ...structuredClone(range), clock, length },
      });
      clock += length;
    }
    return result;
  }

  /** Detached diagnostics for identity/isolation checks; never a provider input. */
  encodeState(): Uint8Array {
    this.#open();
    return Y.encodeStateAsUpdate(this.#doc);
  }

  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = null;
    this.#doc.destroy();
    this.#retained.clear();
    this.#tapes.clear();
    this.#markers.clear();
    this.#positions = new WeakMap();
  }
  #open(): void {
    if (this.#closed) throw new Error('Native cache is closed');
  }
  #idle(): void {
    this.#open();
    if (this.#pending) throw new Error('Finish native preparation before another write');
  }
  #text(tape: TapeId): Y.Text {
    const name = resourceKey(tape);
    if (!this.#tapes.has(name)) throw new NativeValidationError('Unknown native tape');
    return this.#doc.getText(name);
  }
  #insertMarker(
    tapeId: TapeId,
    index: number,
    id: MarkerId,
    affinity: 'left' | 'right',
    allocations: (TapeAllocation | MarkerAllocation)[],
  ): void {
    const name = resourceKey(id);
    if (id.kind !== 'marker' || this.#markers.has(name))
      throw new Error('Duplicate/invalid marker');
    if (affinity !== 'left' && affinity !== 'right') throw new Error('Invalid marker affinity');
    const marker: MarkerAllocation = {
      type: 'marker',
      id,
      tape: tapeId,
      affinity,
      native: {
        client: this.#doc.clientID,
        clock: Y.getState(this.#doc.store, this.#doc.clientID),
      },
    };
    const text = this.#text(tapeId);
    this.#positions.delete(text);
    text.insertEmbed(index, { grainMarker: name });
    this.#markers.set(name, marker);
    allocations.push(marker);
  }
  #assertInsertion(tape: Y.Text, index: number): void {
    if (!Number.isSafeInteger(index) || index < 1 || index >= tape.length)
      throw new Error('Insertion must lie inside permanent tape markers');
    const relative = Y.createRelativePositionFromTypeIndex(tape, index);
    if (relative.item) {
      const item = Y.getItem(this.#doc.store, relative.item);
      if (item.content instanceof Y.ContentString)
        assertTextBoundary(item.content.str, relative.item.clock - item.id.clock);
    }
  }
  #assertSettled(touched: ReadonlySet<string>): void {
    if (this.#doc.store.pendingStructs || this.#doc.store.pendingDs)
      throw new NativeValidationError('Unresolved native dependencies');
    for (const name of touched) {
      const tape = this.#tapes.get(name)!;
      const text = this.#text(tape.id);
      const start = this.#markers.get(resourceKey(tape.start))!;
      const end = this.#markers.get(resourceKey(tape.end))!;
      const first = Y.getItem(this.#doc.store, Y.createID(start.native.client, start.native.clock));
      const last = Y.getItem(this.#doc.store, Y.createID(end.native.client, end.native.clock));
      if (
        first.parent !== text ||
        last.parent !== text ||
        first.left !== null ||
        last.right !== null
      )
        throw new NativeValidationError('Insertion lies outside permanent tape markers');
    }
  }
  #freshClient(previous: number): void {
    while (this.#doc.clientID === previous || this.#doc.store.clients.has(this.#doc.clientID)) {
      const random = new Y.Doc();
      this.#doc.clientID = random.clientID;
      random.destroy();
    }
  }
  #recover(): void {
    const ready = [...this.#retained].map(([key, body]) => ({ key, body }));
    this.rebuild(ready);
  }
}

function copyBody(body: NativeBody): NativeBody {
  return structuredClone(body);
}
function sameBody(a: NativeBody, b: NativeBody): boolean {
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));
  return json(a) === json(b);
}

function excluding<T>(map: ReadonlyMap<string, T>, excluded: ReadonlySet<string>) {
  return {
    get: (key: string) => (excluded.has(key) ? undefined : map.get(key)),
    has: (key: string) => !excluded.has(key) && map.has(key),
  };
}
