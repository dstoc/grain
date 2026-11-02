import * as Y from 'yjs';

import {
  canonicalWriterAccess,
  type CanonicalDocument,
} from '../../src/markdown/canonical-model.js';

type SharedType = Y.Map<unknown> | Y.Array<unknown> | Y.Text;
type InternalItem = {
  readonly parent: SharedType | null;
  readonly parentSub: string | null;
  readonly deleted: boolean;
  readonly length: number;
  readonly constructor: { readonly name: string };
};
type InternalType = SharedType & {
  readonly _item: InternalItem | null;
  readonly doc: Y.Doc | null;
};
type InternalDoc = Y.Doc & {
  readonly store: {
    readonly clients: Map<
      number,
      readonly { readonly deleted?: boolean; readonly length?: number }[]
    >;
  };
};

export interface NativeOperationCounts {
  readonly transactions: number;
  readonly transactionsByOrigin: Readonly<Record<string, number>>;
  readonly mapSets: number;
  readonly unchangedMapSets: number;
  readonly mapDeletes: number;
  readonly arrayInserts: number;
  readonly arrayDeletes: number;
  readonly textInserts: number;
  readonly textEmbeds: number;
  readonly textDeletes: number;
  readonly textFormats: number;
  readonly writesByPath: Readonly<Record<string, number>>;
  readonly unchangedMapSetsByPath: Readonly<Record<string, number>>;
  readonly updateEvents: number;
  readonly updateEventBytes: number;
  readonly deleteSetClients: number;
  readonly deleteSetRanges: number;
  readonly activeAfterTransactionCallbacks: number;
}

export interface NativeStateSnapshot {
  readonly clientIds: readonly number[];
  readonly clientCount: number;
  readonly structCount: number;
  readonly deletedStructCount: number;
  readonly garbageCollectedStructCount: number;
  readonly tapeCount: number;
  readonly markerCount: number;
  readonly spanCount: number;
  readonly nodeCount: number;
  readonly ownership: {
    readonly distinctOwnerNodeCount: number;
    readonly multiSpanNodeCount: number;
    readonly multiOwnerTapeCount: number;
    readonly byTape: readonly {
      readonly spanCount: number;
      readonly ownerCount: number;
      readonly tapeCount: number;
    }[];
  };
  readonly checkpointBytes: number;
  readonly activeAfterTransactionCallbacks: number;
}

interface MutableCounts {
  transactions: number;
  transactionsByOrigin: Map<string, number>;
  mapSets: number;
  unchangedMapSets: number;
  mapDeletes: number;
  arrayInserts: number;
  arrayDeletes: number;
  textInserts: number;
  textEmbeds: number;
  textDeletes: number;
  textFormats: number;
  writesByPath: Map<string, number>;
  unchangedMapSetsByPath: Map<string, number>;
  updateEvents: number;
  updateEventBytes: number;
  deleteSetClients: number;
  deleteSetRanges: number;
}

const encoder = new TextEncoder();

function increment(target: Map<string, number>, key: string): void {
  target.set(key, (target.get(key) ?? 0) + 1);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function typePath(type: SharedType): string {
  const current = type as InternalType;
  const parts: string[] = [];
  let parent: SharedType | null = current;
  while (parent) {
    const item: InternalItem | null = (parent as InternalType)._item;
    if (!item) break;
    parts.unshift(item.parentSub ?? '[]');
    parent = item.parent;
  }
  const root = parent;
  const document = (type as InternalType).doc as Y.Doc | null;
  const rootName = root
    ? [...(document?.share.entries() ?? [])].find(([, shared]) => shared === root)?.[0]
    : undefined;
  return [rootName ?? 'unknown-root', ...parts].join('/');
}

function writePath(type: SharedType, operation: string, key?: string): string {
  const suffix = key === undefined ? operation : `${operation}.${key}`;
  return `${typePath(type)}:${suffix}`;
}

function mapCounts(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function activeCallbacks(document: Y.Doc): number {
  const observers = (
    document as Y.Doc & {
      readonly _observers?: Map<string, Set<unknown>>;
    }
  )._observers;
  return observers?.get('afterTransaction')?.size ?? 0;
}

export function snapshotNativeState(document: CanonicalDocument): NativeStateSnapshot {
  const state = canonicalWriterAccess(document).state as InternalDoc;
  const snapshot = document.canonicalSnapshot();
  let structCount = 0;
  let deletedStructCount = 0;
  let garbageCollectedStructCount = 0;
  for (const structs of state.store.clients.values()) {
    for (const struct of structs) {
      structCount++;
      if (struct.constructor?.name === 'GC') garbageCollectedStructCount++;
      if (struct.deleted) deletedStructCount++;
    }
  }
  const markerCount = snapshot.tapes.reduce(
    (count, tape) => count + tape.delta.filter((item) => typeof item !== 'string').length,
    0,
  );
  const spansByNode = snapshot.nodes.map((node) => ({ nodeId: node.id, spans: node.spans }));
  const ownersByTape = new Map<string, Set<string>>();
  const spanCountsByTape = new Map<string, number>();
  for (const { nodeId, spans } of spansByNode) {
    for (const span of spans) {
      let owners = ownersByTape.get(span.tapeId);
      if (!owners) ownersByTape.set(span.tapeId, (owners = new Set()));
      owners.add(nodeId);
      spanCountsByTape.set(span.tapeId, (spanCountsByTape.get(span.tapeId) ?? 0) + 1);
    }
  }
  const ownershipCounts = new Map<
    string,
    { spanCount: number; ownerCount: number; tapeCount: number }
  >();
  for (const [tapeId, owners] of ownersByTape) {
    const spanCount = spanCountsByTape.get(tapeId) ?? 0;
    const ownerCount = owners.size;
    const signature = `${spanCount}:${ownerCount}`;
    const count = ownershipCounts.get(signature);
    if (count) count.tapeCount++;
    else ownershipCounts.set(signature, { spanCount, ownerCount, tapeCount: 1 });
  }
  const ownershipByTape = [...ownershipCounts.values()].sort(
    (left, right) => left.spanCount - right.spanCount || left.ownerCount - right.ownerCount,
  );
  return {
    clientIds: [...state.store.clients.keys()].sort((left, right) => left - right),
    clientCount: state.store.clients.size,
    structCount,
    deletedStructCount,
    garbageCollectedStructCount,
    tapeCount: snapshot.tapes.length,
    markerCount,
    spanCount: snapshot.nodes.reduce((count, node) => count + node.spans.length, 0),
    nodeCount: snapshot.nodes.length,
    ownership: {
      distinctOwnerNodeCount: new Set(
        spansByNode.filter(({ spans }) => spans.length > 0).map(({ nodeId }) => nodeId),
      ).size,
      multiSpanNodeCount: spansByNode.filter(({ spans }) => spans.length > 1).length,
      multiOwnerTapeCount: [...ownersByTape.values()].filter((owners) => owners.size > 1).length,
      byTape: ownershipByTape,
    },
    checkpointBytes: document.checkpoint().update.byteLength,
    activeAfterTransactionCallbacks: activeCallbacks(state),
  };
}

export function measureNativeOperations<T>(
  document: CanonicalDocument,
  action: () => T,
): { readonly value: T; readonly counts: NativeOperationCounts } {
  const state = canonicalWriterAccess(document).state;
  const mutable: MutableCounts = {
    transactions: 0,
    transactionsByOrigin: new Map(),
    mapSets: 0,
    unchangedMapSets: 0,
    mapDeletes: 0,
    arrayInserts: 0,
    arrayDeletes: 0,
    textInserts: 0,
    textEmbeds: 0,
    textDeletes: 0,
    textFormats: 0,
    writesByPath: new Map(),
    unchangedMapSetsByPath: new Map(),
    updateEvents: 0,
    updateEventBytes: 0,
    deleteSetClients: 0,
    deleteSetRanges: 0,
  };
  const originals: Array<() => void> = [];
  const patchMethod = <T extends object, K extends keyof T>(
    prototype: T,
    name: K,
    replacement: T[K],
  ) => {
    const original = prototype[name];
    prototype[name] = replacement;
    originals.push(() => {
      prototype[name] = original;
    });
  };

  const mapPrototype = Y.Map.prototype as unknown as {
    set: (this: Y.Map<unknown>, key: string, value: unknown) => Y.Map<unknown>;
    delete: (this: Y.Map<unknown>, key: string) => void;
  };
  const mapSet = mapPrototype.set;
  patchMethod(mapPrototype, 'set', function (this: Y.Map<unknown>, key: string, value: unknown) {
    const path = writePath(this, 'set', key);
    mutable.mapSets++;
    increment(mutable.writesByPath, path);
    if (this.has(key) && stableJson(this.get(key)) === stableJson(value)) {
      mutable.unchangedMapSets++;
      increment(mutable.unchangedMapSetsByPath, path);
    }
    return mapSet.call(this, key, value);
  });

  const mapDelete = mapPrototype.delete;
  patchMethod(mapPrototype, 'delete', function (this: Y.Map<unknown>, key: string) {
    mutable.mapDeletes++;
    increment(mutable.writesByPath, writePath(this, 'delete', key));
    return mapDelete.call(this, key);
  });

  const arrayPrototype = Y.Array.prototype as unknown as {
    insert: (this: Y.Array<unknown>, index: number, values: readonly unknown[]) => void;
    delete: (this: Y.Array<unknown>, index: number, length?: number) => void;
  };
  const arrayInsert = arrayPrototype.insert;
  patchMethod(
    arrayPrototype,
    'insert',
    function (this: Y.Array<unknown>, index: number, values: readonly unknown[]) {
      mutable.arrayInserts++;
      increment(mutable.writesByPath, writePath(this, 'insert'));
      return arrayInsert.call(this, index, values);
    },
  );
  const arrayDelete = arrayPrototype.delete;
  patchMethod(
    arrayPrototype,
    'delete',
    function (this: Y.Array<unknown>, index: number, length?: number) {
      mutable.arrayDeletes++;
      increment(mutable.writesByPath, writePath(this, 'delete'));
      return arrayDelete.call(this, index, length);
    },
  );

  const textPrototype = Y.Text.prototype as unknown as {
    insert: (
      this: Y.Text,
      index: number,
      text: string,
      attributes?: Record<string, unknown>,
    ) => void;
    insertEmbed: (
      this: Y.Text,
      index: number,
      embed: unknown,
      attributes?: Record<string, unknown>,
    ) => void;
    delete: (this: Y.Text, index: number, length: number) => void;
    format: (
      this: Y.Text,
      index: number,
      length: number,
      attributes: Record<string, unknown>,
    ) => void;
  };
  const textInsert = textPrototype.insert;
  patchMethod(
    textPrototype,
    'insert',
    function (this: Y.Text, index: number, text: string, attributes?: Record<string, unknown>) {
      mutable.textInserts++;
      increment(mutable.writesByPath, writePath(this, 'insert'));
      return textInsert.call(this, index, text, attributes);
    },
  );
  const textEmbed = textPrototype.insertEmbed;
  patchMethod(
    textPrototype,
    'insertEmbed',
    function (this: Y.Text, index: number, embed: unknown, attributes?: Record<string, unknown>) {
      mutable.textEmbeds++;
      increment(mutable.writesByPath, writePath(this, 'insertEmbed'));
      return textEmbed.call(this, index, embed, attributes);
    },
  );
  const textDelete = textPrototype.delete;
  patchMethod(textPrototype, 'delete', function (this: Y.Text, index: number, length: number) {
    mutable.textDeletes++;
    increment(mutable.writesByPath, writePath(this, 'delete'));
    return textDelete.call(this, index, length);
  });
  const textFormat = textPrototype.format;
  patchMethod(
    textPrototype,
    'format',
    function (this: Y.Text, index: number, length: number, attributes: Record<string, unknown>) {
      mutable.textFormats++;
      increment(mutable.writesByPath, writePath(this, 'format'));
      return textFormat.call(this, index, length, attributes);
    },
  );

  const docPrototype = Y.Doc.prototype as unknown as {
    transact: (this: Y.Doc, callback: () => void, origin?: unknown, local?: boolean) => void;
    on: (this: Y.Doc, event: string, callback: (...args: never[]) => unknown) => unknown;
    off: (this: Y.Doc, event: string, callback: (...args: never[]) => unknown) => unknown;
  };
  const originalTransact = docPrototype.transact;
  patchMethod(
    docPrototype,
    'transact',
    function (this: Y.Doc, callback: () => void, origin?: unknown, local?: boolean) {
      mutable.transactions++;
      increment(mutable.transactionsByOrigin, origin === undefined ? 'undefined' : String(origin));
      return originalTransact.call(this, callback, origin, local);
    },
  );

  const originalOn = docPrototype.on;
  const originalOff = docPrototype.off;
  const updateHandlers = new WeakMap<Y.Doc, (update: Uint8Array) => void>();
  const trackedDocuments = new Set<Y.Doc>();
  const callbackWrappers = new WeakMap<Y.Doc, Map<string, Map<Function, Function>>>();
  const wrap = (doc: Y.Doc, event: string, callback: Function): Function => {
    let byEvent = callbackWrappers.get(doc);
    if (!byEvent) callbackWrappers.set(doc, (byEvent = new Map()));
    let byCallback = byEvent.get(event);
    if (!byCallback) byEvent.set(event, (byCallback = new Map()));
    const existing = byCallback.get(callback);
    if (existing) return existing;
    const wrapped = function (this: Y.Doc, ...args: unknown[]) {
      return callback.apply(this, args);
    };
    byCallback.set(callback, wrapped);
    return wrapped;
  };
  const trackDocument = (doc: Y.Doc): void => {
    if (updateHandlers.has(doc)) return;
    const updateHandler = (update: Uint8Array) => {
      mutable.updateEvents++;
      mutable.updateEventBytes += update.byteLength;
      const deleteSet = Y.decodeUpdate(update).ds as unknown as {
        readonly clients: Record<string, readonly { readonly len: number }[]>;
      };
      const clients = Object.values(deleteSet.clients);
      mutable.deleteSetClients += clients.filter((ranges) => ranges.length > 0).length;
      mutable.deleteSetRanges += clients.reduce((total, ranges) => total + ranges.length, 0);
    };
    updateHandlers.set(doc, updateHandler);
    trackedDocuments.add(doc);
    originalOn.call(doc, 'update', updateHandler as (...args: never[]) => unknown);
    const observers = (doc as Y.Doc & { readonly _observers?: Map<string, Set<Function>> })
      ._observers;
    const existingObservers = observers?.get('afterTransaction');
    if (existingObservers) {
      for (const callback of Array.from(existingObservers)) {
        existingObservers.delete(callback);
        existingObservers.add(wrap(doc, 'afterTransaction', callback));
      }
    }
  };
  patchMethod(
    docPrototype,
    'on',
    function (this: Y.Doc, event: string, callback: (...args: never[]) => unknown) {
      trackDocument(this);
      return originalOn.call(
        this,
        event,
        wrap(this, event, callback) as (...args: never[]) => unknown,
      );
    },
  );
  patchMethod(
    docPrototype,
    'off',
    function (this: Y.Doc, event: string, callback: (...args: never[]) => unknown) {
      const wrapped = callbackWrappers.get(this)?.get(event)?.get(callback) ?? callback;
      return originalOff.call(this, event, wrapped as (...args: never[]) => unknown);
    },
  );
  trackDocument(state);

  let value: T;
  try {
    value = action();
  } finally {
    for (const document of trackedDocuments) {
      const updateHandler = updateHandlers.get(document)!;
      originalOff.call(document, 'update', updateHandler as (...args: never[]) => unknown);
      const observers = (document as Y.Doc & { readonly _observers?: Map<string, Set<Function>> })
        ._observers;
      for (const [event, wrappers] of callbackWrappers.get(document) ?? []) {
        const set = observers?.get(event);
        if (!set) continue;
        for (const [callback, wrapped] of wrappers) {
          if (set.delete(wrapped)) set.add(callback);
        }
      }
    }
    for (const restore of originals.reverse()) restore();
  }

  const stateAfter = canonicalWriterAccess(document).state;
  const counts: NativeOperationCounts = {
    transactions: mutable.transactions,
    transactionsByOrigin: mapCounts(mutable.transactionsByOrigin),
    mapSets: mutable.mapSets,
    unchangedMapSets: mutable.unchangedMapSets,
    mapDeletes: mutable.mapDeletes,
    arrayInserts: mutable.arrayInserts,
    arrayDeletes: mutable.arrayDeletes,
    textInserts: mutable.textInserts,
    textEmbeds: mutable.textEmbeds,
    textDeletes: mutable.textDeletes,
    textFormats: mutable.textFormats,
    writesByPath: mapCounts(mutable.writesByPath),
    unchangedMapSetsByPath: mapCounts(mutable.unchangedMapSetsByPath),
    updateEvents: mutable.updateEvents,
    updateEventBytes: mutable.updateEventBytes,
    deleteSetClients: mutable.deleteSetClients,
    deleteSetRanges: mutable.deleteSetRanges,
    activeAfterTransactionCallbacks: activeCallbacks(stateAfter),
  };
  return { value: value!, counts };
}

export function receiptByteLength(receipt: unknown): number {
  return encoder.encode(JSON.stringify(receipt)).byteLength;
}
