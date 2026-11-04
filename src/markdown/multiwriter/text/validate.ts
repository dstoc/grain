import * as Y from 'yjs';
import type { NativeId, NativeResourceBirth } from '../contracts.js';
import type { MarkerAllocation, NativeBody, TapeAllocation } from './types.js';
import {
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
): BodyInspection {
  const tapes = body.allocations.filter((a): a is TapeAllocation => a.type === 'tape');
  const markers = body.allocations.filter((a): a is MarkerAllocation => a.type === 'marker');
  const allTapes = new Map<string, TapeAllocation>();
  const allMarkers = new Map<string, MarkerAllocation>();
  for (const tape of tapes) {
    const key = resourceKey(tape.id);
    if (tape.id.kind !== 'tape' || allTapes.has(key) || registry.tapes.has(key))
      throw new Error('Duplicate/invalid tape allocation');
    allTapes.set(key, tape);
  }
  for (const marker of markers) {
    const key = resourceKey(marker.id);
    if (marker.id.kind !== 'marker' || allMarkers.has(key) || registry.markers.has(key))
      throw new Error('Duplicate/invalid marker allocation');
    if (marker.affinity !== 'left' && marker.affinity !== 'right')
      throw new Error('Invalid marker affinity');
    assertNative(marker.native);
    if (!(allTapes.has(resourceKey(marker.tape)) || registry.tapes.has(resourceKey(marker.tape))))
      throw new Error('Unknown marker tape');
    allMarkers.set(key, marker);
  }
  for (const tape of tapes) {
    const start = markers.find((m) => resourceKey(m.id) === resourceKey(tape.start));
    const end = markers.find((m) => resourceKey(m.id) === resourceKey(tape.end));
    if (
      !start ||
      !end ||
      start === end ||
      resourceKey(start.tape) !== resourceKey(tape.id) ||
      resourceKey(end.tape) !== resourceKey(tape.id) ||
      start.affinity !== 'left' ||
      end.affinity !== 'right'
    )
      throw new Error('New tape requires distinct permanent start/end markers');
  }

  const items: Y.Item[] = [];
  for (const update of body.nativeInsertUpdates) {
    const decoded = Y.decodeUpdate(update);
    if (decoded.ds.clients.size) throw new Error('Native deletion is prohibited');
    for (const struct of decoded.structs) {
      if (
        !(struct instanceof Y.Item) ||
        struct.parentSub !== null ||
        !(struct.content instanceof Y.ContentString || struct.content instanceof Y.ContentEmbed)
      )
        throw new Error('Only native string and boundary insertions are permitted');
      assertNative(struct.id, struct.length);
      if (struct.content instanceof Y.ContentString) {
        if (!struct.content.str.length) throw new Error('Empty native string');
        assertUnicode(struct.content.str);
      }
      items.push(struct);
    }
  }
  const sorted = [...items].sort((a, b) => a.id.client - b.id.client || a.id.clock - b.id.clock);
  const nextClock = new Map<number, number>();
  for (const item of sorted) {
    const expected =
      nextClock.get(item.id.client) ??
      (insertedLocally ? item.id.clock : Y.getState(doc.store, item.id.client));
    if (item.id.clock !== expected)
      throw new Error('Native body has overlapping IDs or missing clock prefix');
    nextClock.set(item.id.client, item.id.clock + item.length);
  }
  function lookup(id: NativeId): Y.Item {
    assertNative(id);
    const own = items.find(
      (item) =>
        item.id.client === id.client &&
        item.id.clock <= id.clock &&
        id.clock < item.id.clock + item.length,
    );
    if (own) return own;
    if (id.clock >= Y.getState(doc.store, id.client)) throw new Error('Missing native origin');
    const item = Y.getItem(doc.store, Y.createID(id.client, id.clock));
    if (!(item instanceof Y.Item) || item.deleted) throw new Error('Invalid native origin');
    return item;
  }
  const roots = new Map<Y.Item, string>();
  const resolving = new Set<Y.Item>();
  function root(item: Y.Item): string {
    const cached = roots.get(item);
    if (cached) return cached;
    if (resolving.has(item)) throw new Error('Cyclic native origins');
    resolving.add(item);
    // Decoded Yjs roots are strings although the installed Item declaration omits this case.
    const parent: unknown = item.parent;
    let name: string;
    if (typeof parent === 'string') name = parent;
    else if (parent instanceof Y.Text && parent._item === null) {
      // Already integrated items have validated ancestry; do not walk the retained history.
      name = Y.findRootTypeKey(parent);
      if (!(allTapes.has(name) || registry.tapes.has(name))) throw new Error('Unknown native tape');
      roots.set(item, name);
      resolving.delete(item);
      return name;
    } else if (parent === null) {
      const origin = item.origin ?? item.rightOrigin;
      if (!origin) throw new Error('Missing native parent');
      name = root(lookup(origin));
    } else throw new Error('Nested or non-text native parent');
    if (!(allTapes.has(name) || registry.tapes.has(name))) throw new Error('Unknown native tape');
    for (const [origin, after] of [
      [item.origin, true],
      [item.rightOrigin, false],
    ] as const) {
      if (!origin) continue;
      const anchor = lookup(origin);
      if (root(anchor) !== name) throw new Error('Native origins cross tapes');
      if (anchor.content instanceof Y.ContentString)
        assertTextBoundary(anchor.content.str, origin.clock - anchor.id.clock + (after ? 1 : 0));
    }
    roots.set(item, name);
    resolving.delete(item);
    return name;
  }
  const births: NativeResourceBirth[] = [];
  const touched = new Set<string>();
  const bornMarkers = new Set<string>();
  for (const item of items) {
    const name = root(item);
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
        throw new Error('Unsupported native embed');
      const marker = allMarkers.get(embed.grainMarker);
      if (
        !marker ||
        !markers.includes(marker) ||
        bornMarkers.has(embed.grainMarker) ||
        resourceKey(marker.tape) !== name ||
        nativeKey(marker.native) !== nativeKey(native)
      )
        throw new Error('Marker embed does not match its allocation');
      bornMarkers.add(embed.grainMarker);
      births.push({ type: 'marker', tape, native, marker: marker.id });
    }
  }
  if (bornMarkers.size !== markers.length)
    throw new Error('Marker allocation has no native insertion');
  if (JSON.stringify(manifestKeys(births)) !== JSON.stringify(manifestKeys(body.nativeManifest)))
    throw new Error('Native insertion manifest differs from body');
  for (const tape of tapes)
    if (!touched.has(resourceKey(tape.id))) throw new Error('Empty tape body');
  return { tapes, markers, touched };
}

function manifestKeys(manifest: readonly NativeResourceBirth[]): readonly string[] {
  return manifest
    .map((birth) => {
      assertNative(birth.native, birth.type === 'text' ? birth.native.length : 1);
      return JSON.stringify(
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
      );
    })
    .sort();
}
