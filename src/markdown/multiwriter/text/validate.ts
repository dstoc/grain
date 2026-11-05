import { DEFAULT_INGEST_LIMITS, finish, guardDecode } from '../ingest/work.js';
import type { Work } from '../ingest/work.js';
import { scanUpdate } from '../ingest/preflight.js';
import * as Y from 'yjs';
import type { NativeId, NativeResourceBirth } from '../contracts.js';
import type { MarkerAllocation, NativeBody, TapeAllocation } from './types.js';
import {
  NativeValidationError,
  assertNative,
  assertTextBoundary,
  assertUnicode,
  nativeKey,
  resourceKey,
} from './identity.js';

export interface NativeRegistry {
  readonly tapes: Pick<ReadonlyMap<string, TapeAllocation>, 'get' | 'has'>;
  readonly markers: Pick<ReadonlyMap<string, MarkerAllocation>, 'get' | 'has'>;
}
export interface BodyInspection {
  readonly tapes: readonly TapeAllocation[];
  readonly markers: readonly MarkerAllocation[];
  readonly touched: ReadonlySet<string>;
}

/** Validate decoded structs before they enter the private doc. No disposable document per edit. */
export function inspectBody(
  doc: Y.Doc,
  registry: NativeRegistry,
  body: NativeBody,
  insertedLocally = false,
  decodeOperations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
): BodyInspection {
  return finish(inspectBodySteps(doc, registry, body, insertedLocally, decodeOperations));
}

export function* inspectBodySteps(
  doc: Y.Doc,
  registry: NativeRegistry,
  body: NativeBody,
  insertedLocally = false,
  decodeOperations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
): Work<BodyInspection> {
  const tapes = body.allocations.filter((a): a is TapeAllocation => a.type === 'tape');
  const markers = body.allocations.filter((a): a is MarkerAllocation => a.type === 'marker');
  const allTapes = new Map<string, TapeAllocation>();
  const allMarkers = new Map<string, MarkerAllocation>();
  for (const tape of tapes) {
    yield;
    const key = resourceKey(tape.id);
    if (tape.id.kind !== 'tape' || allTapes.has(key) || registry.tapes.has(key))
      throw new NativeValidationError('Duplicate/invalid tape allocation');
    allTapes.set(key, tape);
  }
  for (const marker of markers) {
    yield;
    const key = resourceKey(marker.id);
    if (marker.id.kind !== 'marker' || allMarkers.has(key) || registry.markers.has(key))
      throw new NativeValidationError('Duplicate/invalid marker allocation');
    if (marker.affinity !== 'left' && marker.affinity !== 'right')
      throw new NativeValidationError('Invalid marker affinity');
    assertNative(marker.native);
    if (!(allTapes.has(resourceKey(marker.tape)) || registry.tapes.has(resourceKey(marker.tape))))
      throw new NativeValidationError('Unknown marker tape');
    allMarkers.set(key, marker);
  }
  for (const tape of tapes) {
    yield;
    const start = allMarkers.get(resourceKey(tape.start));
    const end = allMarkers.get(resourceKey(tape.end));
    if (
      !start ||
      !end ||
      start === end ||
      resourceKey(start.tape) !== resourceKey(tape.id) ||
      resourceKey(end.tape) !== resourceKey(tape.id) ||
      start.affinity !== 'left' ||
      end.affinity !== 'right'
    )
      throw new NativeValidationError('New tape requires distinct permanent start/end markers');
  }

  const items: Y.Item[] = [];
  for (const update of body.nativeInsertUpdates) {
    yield* guardDecode(scanUpdate(update, 'native'), decodeOperations, 'native');
    const decoded = Y.decodeUpdate(update);
    if (decoded.ds.clients.size) throw new NativeValidationError('Native deletion is prohibited');
    for (const struct of decoded.structs) {
      yield;
      if (
        !(struct instanceof Y.Item) ||
        struct.parentSub !== null ||
        !(struct.content instanceof Y.ContentString || struct.content instanceof Y.ContentEmbed)
      )
        throw new NativeValidationError('Only native string and boundary insertions are permitted');
      assertNative(struct.id, struct.length);
      if (struct.content instanceof Y.ContentString) {
        if (!struct.content.str.length) throw new NativeValidationError('Empty native string');
        assertUnicode(struct.content.str);
      }
      items.push(struct);
    }
  }
  const sorted = [...items].sort((a, b) => a.id.client - b.id.client || a.id.clock - b.id.clock);
  const nextClock = new Map<number, number>();
  for (const item of sorted) {
    yield;
    const expected =
      nextClock.get(item.id.client) ??
      (insertedLocally ? item.id.clock : Y.getState(doc.store, item.id.client));
    if (item.id.clock !== expected)
      throw new NativeValidationError('Native body has overlapping IDs or missing clock prefix');
    nextClock.set(item.id.client, item.id.clock + item.length);
  }
  const ownClients = new Map<number, Y.Item[]>();
  for (const item of sorted) {
    yield;
    const list = ownClients.get(item.id.client) ?? [];
    list.push(item);
    ownClients.set(item.id.client, list);
  }
  function lookup(id: NativeId): Y.Item {
    assertNative(id);
    const list = ownClients.get(id.client) ?? [];
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (list[middle].id.clock <= id.clock) low = middle + 1;
      else high = middle;
    }
    const own = list[low - 1];
    if (own && id.clock < own.id.clock + own.length) return own;
    if (id.clock >= Y.getState(doc.store, id.client))
      throw new NativeValidationError('Missing native origin');
    const item = Y.getItem(doc.store, Y.createID(id.client, id.clock));
    if (!(item instanceof Y.Item) || item.deleted)
      throw new NativeValidationError('Invalid native origin');
    return item;
  }
  const roots = new Map<Y.Item, string>();
  function* root(first: Y.Item): Work<string> {
    const visiting = new Set<Y.Item>();
    const stack: { item: Y.Item; finish: boolean }[] = [{ item: first, finish: false }];
    while (stack.length) {
      yield;
      const { item, finish } = stack.pop()!;
      if (roots.has(item)) continue;
      const parent: unknown = item.parent;
      if (parent instanceof Y.Text && parent._item === null) {
        const name = Y.findRootTypeKey(parent);
        if (!(allTapes.has(name) || registry.tapes.has(name)))
          throw new NativeValidationError('Unknown native tape');
        roots.set(item, name);
        continue;
      }
      if (!finish) {
        if (visiting.has(item)) throw new NativeValidationError('Cyclic native origins');
        visiting.add(item);
        stack.push({ item, finish: true });
        for (const origin of [item.origin, item.rightOrigin])
          if (origin) stack.push({ item: lookup(origin), finish: false });
        continue;
      }
      let name: string;
      if (typeof parent === 'string') name = parent;
      else if (parent === null) {
        const origin = item.origin ?? item.rightOrigin;
        if (!origin) throw new NativeValidationError('Missing native parent');
        name = roots.get(lookup(origin))!;
      } else throw new NativeValidationError('Nested or non-text native parent');
      if (!(allTapes.has(name) || registry.tapes.has(name)))
        throw new NativeValidationError('Unknown native tape');
      for (const [origin, after] of [
        [item.origin, true],
        [item.rightOrigin, false],
      ] as const) {
        if (!origin) continue;
        const anchor = lookup(origin);
        if (roots.get(anchor) !== name)
          throw new NativeValidationError('Native origins cross tapes');
        if (anchor.content instanceof Y.ContentString)
          assertTextBoundary(anchor.content.str, origin.clock - anchor.id.clock + (after ? 1 : 0));
      }
      roots.set(item, name);
      visiting.delete(item);
    }
    return roots.get(first)!;
  }
  const births: NativeResourceBirth[] = [];
  const touched = new Set<string>();
  const bornMarkers = new Set<string>();
  for (const item of items) {
    yield;
    const name = yield* root(item);
    const tape = (allTapes.get(name) ?? registry.tapes.get(name))!.id;
    touched.add(name);
    const native = { client: item.id.client, clock: item.id.clock };
    if (item.content instanceof Y.ContentString) {
      births.push({
        type: 'text',
        tape,
        native: { ...native, length: item.length },
        text: item.content.str,
      });
    } else {
      const embed = (item.content as Y.ContentEmbed).embed;
      if (
        !embed ||
        typeof embed !== 'object' ||
        Object.keys(embed).length !== 1 ||
        !('grainMarker' in embed) ||
        typeof embed.grainMarker !== 'string'
      )
        throw new NativeValidationError('Unsupported native embed');
      const marker = allMarkers.get(embed.grainMarker);
      if (
        !marker ||
        bornMarkers.has(embed.grainMarker) ||
        resourceKey(marker.tape) !== name ||
        nativeKey(marker.native) !== nativeKey(native)
      )
        throw new NativeValidationError('Marker embed does not match its allocation');
      bornMarkers.add(embed.grainMarker);
      births.push({ type: 'marker', tape, native, marker: marker.id });
    }
  }
  yield* assertInsertionOrder(items, lookup);
  if (bornMarkers.size !== markers.length)
    throw new NativeValidationError('Marker allocation has no native insertion');
  if (
    JSON.stringify(yield* manifestKeys(births)) !==
    JSON.stringify(yield* manifestKeys(body.nativeManifest))
  )
    throw new NativeValidationError('Native insertion manifest differs from body');
  for (const tape of tapes)
    if (!touched.has(resourceKey(tape.id))) throw new NativeValidationError('Empty tape body');
  return { tapes, markers, touched };
}

/** Check strict ordering without integrating untrusted structs or requiring adjacent anchors. */
function* assertInsertionOrder(
  items: readonly Y.Item[],
  lookup: (id: NativeId) => Y.Item,
): Work<void> {
  const edges = new Map<string, Set<string>>();
  const references = new Map<Y.Item, NativeId[]>();
  function vertex(id: NativeId): string {
    const key = nativeKey(id);
    if (!edges.has(key)) {
      edges.set(key, new Set());
      const item = lookup(id);
      const ids = references.get(item) ?? [];
      ids.push(id);
      references.set(item, ids);
    }
    return key;
  }
  function before(left: NativeId, right: NativeId): void {
    const from = vertex(left);
    const to = vertex(right);
    edges.get(from)!.add(to);
  }
  for (const item of items) {
    yield;
    const first = item.id;
    const last = { client: item.id.client, clock: item.id.clock + item.length - 1 };
    vertex(first);
    vertex(last);
    if (item.origin) before(item.origin, first);
    if (item.rightOrigin) before(last, item.rightOrigin);
  }
  // IDs within a string retain clock order even if later insertions split the string.
  const own = new Set(items);
  const retained = new Map<Y.Text, Map<Y.Item, readonly NativeId[]>>();
  for (const [item, ids] of references) {
    yield;
    ids.sort((a, b) => a.clock - b.clock);
    for (let i = 1; i < ids.length; i++) before(ids[i - 1], ids[i]);
    if (!own.has(item)) {
      const parent = item.parent as Y.Text;
      const anchors = retained.get(parent) ?? new Map<Y.Item, readonly NativeId[]>();
      anchors.set(item, ids);
      retained.set(parent, anchors);
    }
  }
  // Existing native order is immutable. Find the retained anchors around the
  // first one, rather than locating each anchor from the beginning of its tape.
  // This visits the interval containing those anchors, including concurrent text.
  for (const anchors of retained.values()) {
    const first = anchors.keys().next().value!;
    const center = anchors.get(first)!;
    anchors.delete(first);
    const left: (readonly NativeId[])[] = [],
      right: (readonly NativeId[])[] = [];
    let beforeItem = first.left,
      afterItem = first.right;
    while (anchors.size) {
      yield;
      if (!beforeItem && !afterItem)
        throw new NativeValidationError('Native anchors are not in one tape');
      if (beforeItem) {
        const ids = anchors.get(beforeItem);
        if (ids) {
          left.push(ids);
          anchors.delete(beforeItem);
        }
        beforeItem = beforeItem.left;
      }
      if (!anchors.size) break;
      if (afterItem) {
        const ids = anchors.get(afterItem);
        if (ids) {
          right.push(ids);
          anchors.delete(afterItem);
        }
        afterItem = afterItem.right;
      }
    }
    const ordered = [...left.reverse().flat(), ...center, ...right.flat()];
    for (let i = 1; i < ordered.length; i++) before(ordered[i - 1], ordered[i]);
  }
  const incoming = new Map([...edges.keys()].map((key) => [key, 0]));
  for (const next of edges.values())
    for (const key of next) incoming.set(key, incoming.get(key)! + 1);
  const ready = [...incoming.keys()].filter((key) => incoming.get(key) === 0);
  let visited = 0;
  while (ready.length) {
    yield;
    const key = ready.pop()!;
    visited++;
    for (const next of edges.get(key)!) {
      const count = incoming.get(next)! - 1;
      incoming.set(next, count);
      if (!count) ready.push(next);
    }
  }
  if (visited !== edges.size)
    throw new NativeValidationError('Contradictory native insertion bounds');
}

function* manifestKeys(manifest: readonly NativeResourceBirth[]): Work<readonly string[]> {
  const result: string[] = [];
  for (const birth of manifest) {
    yield;
    assertNative(birth.native, birth.type === 'text' ? birth.native.length : 1);
    result.push(
      JSON.stringify(
        birth.type === 'text'
          ? [
              'text',
              resourceKey(birth.tape),
              birth.native.client,
              birth.native.clock,
              birth.native.length,
              birth.text,
            ]
          : [
              'marker',
              resourceKey(birth.tape),
              birth.native.client,
              birth.native.clock,
              resourceKey(birth.marker),
            ],
      ),
    );
  }
  return result.sort();
}
