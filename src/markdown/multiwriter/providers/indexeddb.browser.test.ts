import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ActionStore } from '../actions/store.js';
import { action, A, B, C, validateStorageAction } from '../actions/test-fixtures.js';
import type { DeliveryRoute, SyncMode } from '../contracts.js';
import {
  captureCheckpoint,
  decodeCheckpoint,
  restoreCheckpoint,
  journalBytes,
} from '../checkpoints/index.js';
import { decodeCbor, encodeCbor } from '../actions/cbor.js';
import type { CborValue } from '../actions/cbor.js';
import { DirectionalActionProvider } from './adapter.js';
import { IndexedDBActionJournal } from './indexeddb.js';
import type { ActionJournal, JournalIdentity } from './types.js';

const databases: string[] = [];
const connections: IDBDatabase[] = [];
const journals: IndexedDBActionJournal[] = [];
const providers: DirectionalActionProvider[] = [];
const stores: ActionStore[] = [];
const routes: DeliveryRoute[] = ['peer', 'catch-up', 'self-echo', 'cross-tab'];
function identity(): JournalIdentity {
  const namespace = `test-${crypto.randomUUID()}`;
  databases.push(`grain-actionDoc:${namespace}`);
  return { namespace, protocolVersion: 3, documentId: 'D', genesisId: 'G' };
}
function store() {
  const value = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: [],
    validate: validateStorageAction,
  });
  stores.push(value);
  return value;
}
async function journal(id: JournalIdentity) {
  const value = await IndexedDBActionJournal.open(id);
  journals.push(value);
  return value;
}
async function open(id: JournalIdentity, mode: SyncMode = 'bidirectional', value = store()) {
  const storage = await journal(id);
  const provider = await DirectionalActionProvider.open({ store: value, journal: storage, mode });
  providers.push(provider);
  return { provider, storage, value };
}
function source() {
  const value = store();
  const updates: Uint8Array[] = [];
  value.onUpdate((update) => updates.push(update));
  const a1 = action();
  value.append(a1);
  value.append(action(A, 2n, [a1]));
  return updates;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const provider of providers.splice(0)) await provider.close().catch(() => {});
  for (const storage of journals.splice(0)) storage.close();
  for (const value of stores.splice(0)) value.destroy();
  for (const db of connections.splice(0)) db.close();
  await Promise.all(
    databases.splice(0).map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error(`Test leaked a connection: ${name}`));
        }),
    ),
  );
});

it.each(routes.flatMap((route) => ['no-event', 'mixed-message'].map((kind) => ({ route, kind }))))(
  'reopens real IndexedDB with $kind raw ingress via $route before U1',
  async ({ route, kind }) => {
    const id = identity();
    const target = await open(id);
    const updates = source();
    const other = store();
    other.append(action(C));
    const incoming =
      kind === 'no-event' ? updates[1].slice() : Y.mergeUpdates([updates[1], other.encodeUpdate()]);
    const events: Uint8Array[] = [];
    target.value.onUpdate((update) => events.push(update));
    const vector = target.value.encodeStateVector();
    target.provider.receive(route, incoming);
    expect(events).toHaveLength(kind === 'no-event' ? 0 : 1);
    if (kind === 'no-event') expect(target.value.encodeStateVector()).toEqual(vector);
    incoming.fill(0);
    target.value.append(action(B));
    await target.provider.flush();
    await target.provider.close();
    // A new database connection and ActionStore; U1 has never reached this journal.
    const restored = await open(id, 'disconnected');
    expect(restored.value.snapshot()).toEqual(target.value.snapshot());
    expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
    restored.value.applyUpdate(updates[0]);
    target.value.applyUpdate(updates[0]);
    expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
    expect(restored.value.snapshot()).toEqual(target.value.snapshot());
    expect(restored.value.snapshot().ready).toHaveLength(kind === 'no-event' ? 3 : 4);
  },
);

it.each(['bidirectional', 'outbound-only', 'inbound-only', 'disconnected'] as const)(
  'restores pending actions, variants, controls and native identity in %s mode',
  async (mode) => {
    const id = identity();
    const value = store();
    const a1 = action();
    value.append(a1);
    value.append({ ...a1, groupId: { ...a1.groupId, sequence: 2n } }); // Retained fork.
    const b1 = action(B);
    value.append(action(B, 2n, [b1])); // Semantically pending, outer integrated.
    const c1 = action(C);
    value.append(c1);
    value.append({
      ...action(C, 2n, [c1]),
      effects: [
        {
          type: 'SetGroupActive',
          group: c1.groupId,
          actions: [c1.id],
          active: false,
          previousControl: null,
        },
      ],
    });
    const target = await open(id, mode, value);
    await target.provider.consolidate();
    await target.provider.close();
    const restored = await open(id, mode);
    expect(restored.value.snapshot()).toEqual(value.snapshot());
    expect(restored.value.encodeUpdate()).toEqual(value.encodeUpdate());
    expect(restored.value.snapshot().actions[0].variants).toHaveLength(2);
  },
);

it('seeds preexisting unresolved structs and isolates separate namespaces while receive-disabled', async () => {
  const updates = source();
  const id = identity();
  const value = store();
  value.applyUpdate(updates[1]);
  const target = await open(id, 'outbound-only', value);
  await target.provider.close();
  const other = await open(identity(), 'disconnected');
  other.value.append(action(B));
  await other.provider.flush();
  const restored = await open(id, 'outbound-only');
  expect(restored.value.encodeUpdate()).toEqual(value.encodeUpdate());
  expect(restored.provider.receive('cross-tab', other.value.encodeUpdate())).toBe(false);
  expect(restored.value.encodeUpdate()).toEqual(value.encodeUpdate());
  restored.provider.setMode('bidirectional');
  restored.provider.receive('peer', updates[0]);
  value.applyUpdate(updates[0]);
  expect(restored.value.encodeUpdate()).toEqual(value.encodeUpdate());
});

it.each(['documentId', 'genesisId', 'protocolVersion'] as const)(
  'rejects namespace %s mismatch without replacing the journal',
  async (field) => {
    const id = identity();
    const original = await journal(id);
    const updates = source();
    await original.append(updates[0]);
    original.close();
    const mismatch = {
      ...id,
      [field]: field === 'protocolVersion' ? 4 : 'other',
    } as JournalIdentity;
    await expect(IndexedDBActionJournal.open(mismatch)).rejects.toThrow('identity mismatch');
    const reopened = await journal(id);
    expect(await reopened.read()).toEqual([updates[0]]);
  },
);

it('acknowledges transaction completion, copies buffers and rejects an abort after request success', async () => {
  const storage = await journal(identity());
  const bytes = source()[0].slice();
  const expected = bytes.slice();
  let settled = false;
  let requestSucceeded = false;
  const original = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    const request = original.call(this, value, key);
    request.addEventListener('success', () => {
      requestSucceeded = true;
      expect(settled).toBe(false);
      this.transaction.abort();
    });
    return request;
  });
  const append = storage.append(bytes).finally(() => {
    settled = true;
  });
  await expect(append).rejects.toThrow('aborted');
  expect(requestSucceeded).toBe(true);
  expect(await storage.read()).toEqual([]);
  spy.mockRestore();
  const successful = storage.append(bytes);
  bytes.fill(0);
  await successful;
  expect(await storage.read()).toEqual([expected]);
});

it.each(['no-event', 'mixed-message'])(
  'aborted $kind raw ingress keeps close unsaved and retry restores complete coverage',
  async (kind) => {
    const id = identity();
    const target = await open(id);
    await target.provider.flush();
    const updates = source();
    const independent = store();
    independent.append(action(C));
    const original = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = original.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    target.provider.receive(
      'peer',
      kind === 'no-event' ? updates[1] : Y.mergeUpdates([updates[1], independent.encodeUpdate()]),
    );
    await expect(target.provider.close()).rejects.toThrow('aborted');
    spy.mockRestore();
    await target.provider.retryPersistence();
    await target.provider.close();
    const restored = await open(id, 'disconnected');
    expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
    restored.value.applyUpdate(updates[0]);
    target.value.applyUpdate(updates[0]);
    expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
  },
);

it('reports quota errors without deleting durable data and retries later local work', async () => {
  const id = identity();
  const target = await open(id);
  target.value.append(action());
  const durable = target.provider.capturePublication();
  await target.provider.flush();
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  target.value.append(action(B));
  const unsaved = target.provider.capturePublication();
  await expect(target.provider.flush()).rejects.toThrow('Quota exceeded');
  expect(durable.status().persisted).toBe(true);
  expect(unsaved.status()).toEqual({ applied: true, persisted: false });
  spy.mockRestore();
  await target.provider.retryPersistence();
  await target.provider.close();
  const restored = await open(id);
  expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
});

it('fails open on corrupt persisted input rather than opening empty', async () => {
  const id = identity();
  const storage = await journal(id);
  await storage.append(new Uint8Array([255]));
  storage.close();
  await expect(open(id, 'disconnected')).rejects.toThrow();
});

it('rejects a nonbinary persisted entry instead of leaving restore pending', async () => {
  const id = identity();
  const storage = await journal(id);
  storage.close();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`grain-actionDoc:${id.namespace}`, 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('updates', 'readwrite');
    transaction.objectStore('updates').add(42);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
  await expect(open(id, 'disconnected')).rejects.toThrow('nonbinary update');
});

it('propagates IndexedDB open/version errors without opening an empty replacement', async () => {
  const id = identity();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`grain-actionDoc:${id.namespace}`, 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  await expect(IndexedDBActionJournal.open(id)).rejects.toMatchObject({ name: 'VersionError' });
});

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
  });
}
/** Version-1 opener used by the unchanged MW-11 reader, including its metadata/update layout. */
function oldConnection(id: JournalIdentity): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`grain-actionDoc:${id.namespace}`, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('metadata');
      request.result.createObjectStore('updates', { autoIncrement: true });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      connections.push(request.result);
      resolve(request.result);
    };
  });
}
async function legacy(id: JournalIdentity, updates: readonly Uint8Array[]) {
  const db = await oldConnection(id);
  const transaction = db.transaction(['metadata', 'updates'], 'readwrite');
  const done = complete(transaction);
  transaction.objectStore('metadata').put(id, 'identity');
  for (const update of updates) transaction.objectStore('updates').add(update);
  await done;
  return db;
}
async function currentConnection(id: JournalIdentity) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`grain-actionDoc:${id.namespace}`, 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      connections.push(request.result);
      resolve(request.result);
    };
  });
}
async function readLegacy(db: IDBDatabase) {
  const transaction = db.transaction('updates', 'readonly');
  const done = complete(transaction);
  const request = transaction.objectStore('updates').getAll();
  await done;
  return request.result as Uint8Array[];
}

it('migrates a populated legacy journal losslessly and fences version 1 before first consolidation', async () => {
  const id = identity();
  const updates = source();
  const old = await legacy(id, updates);
  expect(await readLegacy(old)).toEqual(updates);
  old.close();
  const storage = await journal(id);
  expect(await storage.read()).toEqual(updates);
  const target = await DirectionalActionProvider.open({
    store: store(),
    journal: storage,
    mode: 'disconnected',
  });
  providers.push(target);
  await target.close();
  await expect(oldConnection(id)).rejects.toMatchObject({ name: 'VersionError' });
  const reopened = await open(id, 'disconnected');
  const expected = store();
  for (const update of updates) expected.applyUpdate(update);
  expect(reopened.value.encodeUpdate()).toEqual(expected.encodeUpdate());
  await reopened.provider.consolidate();
  expect(decodeCheckpoint((await reopened.storage.readCheckpoint()).checkpoint!).update).toEqual(
    expected.encodeUpdate(),
  );
});

it.each([false, true])(
  'reopens checkpoint plus nonempty tail=%s and fences old readers/inherited read',
  async (tail) => {
    const id = identity();
    const target = await open(id);
    target.value.append(action());
    await target.provider.consolidate();
    if (tail) {
      target.value.append(action(B));
      await target.provider.flush();
    }
    const state = await target.storage.readCheckpoint();
    expect(state.updates).toHaveLength(tail ? 1 : 0);
    await expect(target.storage.read()).rejects.toThrow('Checkpoint-aware');
    const append = vi.spyOn(target.storage, 'append');
    const template = store();
    const subscribe = vi.spyOn(template, 'onUpdate');
    const inherited: ActionJournal = {
      read: () => target.storage.read(),
      append: (update) => target.storage.append(update),
      close: () => {},
    };
    await expect(
      DirectionalActionProvider.open({
        store: template,
        journal: inherited,
        mode: 'bidirectional',
      }),
    ).rejects.toThrow('Checkpoint-aware');
    expect(append).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    await target.provider.close();
    await expect(oldConnection(id)).rejects.toMatchObject({ name: 'VersionError' });
    const reopened = await open(id, 'outbound-only');
    expect(reopened.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
    expect(reopened.value.snapshot()).toEqual(target.value.snapshot());
  },
);

it.each(
  [false, true].flatMap((tail) =>
    ['undefined', 'corrupt', 'unsupported'].map((kind) => ({ tail, kind })),
  ),
)(
  'rejects present $kind checkpoint with nonempty tail=$tail before subscription or seed',
  async ({ tail, kind }) => {
    const id = identity();
    const storage = await journal(id);
    storage.close();
    const db = await currentConnection(id);
    let bytes: unknown = undefined;
    if (kind === 'corrupt') bytes = new Uint8Array([255]);
    if (kind === 'unsupported') {
      const fields = decodeCbor(await captureCheckpoint(store())) as Record<string, CborValue>;
      fields.formatVersion = 9n;
      bytes = encodeCbor(fields);
    }
    const transaction = db.transaction(['metadata', 'updates'], 'readwrite');
    const done = complete(transaction);
    transaction.objectStore('metadata').put(bytes, 'checkpoint');
    if (tail) transaction.objectStore('updates').add(source()[0]);
    await done;
    db.close();
    const reopened = await journal(id);
    await expect(reopened.read()).rejects.toThrow();
    const template = store();
    const subscribe = vi.spyOn(template, 'onUpdate');
    const append = vi.spyOn(reopened, 'append');
    await expect(
      DirectionalActionProvider.open({ store: template, journal: reopened, mode: 'disconnected' }),
    ).rejects.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  },
);

it.each(
  [false, true].flatMap((checkpoint) =>
    (['put', 'clear'] as const).map((operation) => ({ checkpoint, operation })),
  ),
)(
  'aborts after $operation success and preserves old checkpoint=$checkpoint',
  async ({ checkpoint, operation }) => {
    const id = identity();
    const target = await open(id);
    target.value.append(action());
    await target.provider.flush();
    if (checkpoint) {
      await target.provider.consolidate();
      target.value.append(action(B));
      await target.provider.flush();
    }
    const before = await target.storage.readCheckpoint();
    let succeeded = false;
    let settled = false;
    const original = IDBObjectStore.prototype[operation];
    // Both request types have the same transaction lifetime; intercept only replacement.
    const spy = vi.spyOn(IDBObjectStore.prototype, operation).mockImplementation(function (
      this: IDBObjectStore,
      ...args: unknown[]
    ) {
      const request = Reflect.apply(original, this, args) as IDBRequest;
      request.addEventListener('success', () => {
        succeeded = true;
        expect(settled).toBe(false);
        this.transaction.abort();
      });
      return request;
    });
    const replacing = target.provider.consolidate().finally(() => {
      settled = true;
    });
    await expect(replacing).rejects.toThrow('aborted');
    expect(succeeded).toBe(true);
    spy.mockRestore();
    expect(await target.storage.readCheckpoint()).toEqual(before);
    // Later writes wait behind retry; checkpoint remains the originally captured prefix.
    target.value.append(action(C));
    await target.provider.retryPersistence();
    expect((await target.storage.readCheckpoint()).updates).toHaveLength(1);
    await target.provider.close();
    const restored = await open(id);
    expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
  },
);

it('aborts a synchronous failure after checkpoint put rather than committing a partial generation', async () => {
  const id = identity();
  const target = await open(id);
  target.value.append(action());
  await target.provider.flush();
  const before = await target.storage.readCheckpoint();
  const spy = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  await expect(target.provider.consolidate()).rejects.toThrow('Quota exceeded');
  spy.mockRestore();
  expect(await target.storage.readCheckpoint()).toEqual(before);
  await target.provider.retryPersistence();
  await target.provider.close();
  const restored = await open(id);
  expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
});

it('copies checkpoint buffers and recovers new checkpoint plus only committed later transactions', async () => {
  const id = identity();
  const value = store();
  value.append(action());
  const storage = await journal(id);
  await storage.append(value.encodeUpdate());
  const bytes = await captureCheckpoint(value);
  const expected = bytes.slice();
  const replacing = storage.replaceWithCheckpoint(bytes);
  bytes.fill(0);
  await replacing;
  expect(await storage.readCheckpoint()).toEqual({ checkpoint: expected, updates: [] });
  const b = store();
  b.append(action(B));
  await storage.append(b.encodeUpdate());
  const before = await storage.readCheckpoint();
  const original = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    input: unknown,
    key?: IDBValidKey,
  ) {
    const request = original.call(this, input, key);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
  const c = store();
  c.append(action(C));
  await expect(storage.append(c.encodeUpdate())).rejects.toThrow('aborted');
  spy.mockRestore();
  expect(await storage.readCheckpoint()).toEqual(before);
  storage.close();
  const restored = await open(id);
  value.applyUpdate(b.encodeUpdate());
  expect(restored.value.encodeUpdate()).toEqual(value.encodeUpdate());
  expect(restored.value.snapshot().ready).toHaveLength(2);
});

it('rolls back an aborted version upgrade with the full version-1 journal intact', async () => {
  const id = identity();
  const updates = source();
  (await legacy(id, updates)).close();
  const original = indexedDB.open.bind(indexedDB);
  const spy = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
    const request = original(name, version);
    request.addEventListener('upgradeneeded', () => {
      const transaction = request.transaction!;
      transaction.objectStore('metadata').put('roll back', 'checkpoint');
      const clear = transaction.objectStore('updates').clear();
      clear.onsuccess = () => transaction.abort();
    });
    return request;
  });
  await expect(IndexedDBActionJournal.open(id)).rejects.toMatchObject({ name: 'AbortError' });
  spy.mockRestore();
  const old = await oldConnection(id);
  expect(old.version).toBe(1);
  expect(await readLegacy(old)).toEqual(updates);
});

it('rejects a blocked upgrade and closes the late successful connection without resetting data', async () => {
  const id = identity();
  const updates = source();
  const old = await legacy(id, updates); // Hold old connection, deliberately no versionchange handler.
  const original = indexedDB.open.bind(indexedDB);
  let late = false;
  const spy = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
    const request = original(name, version);
    request.addEventListener('success', () => {
      late = true;
    });
    return request;
  });
  await expect(IndexedDBActionJournal.open(id)).rejects.toThrow('close other connections');
  expect(await readLegacy(old)).toEqual(updates);
  old.close();
  await vi.waitFor(() => expect(late).toBe(true));
  spy.mockRestore();
  const reopened = await journal(id);
  expect(await reopened.read()).toEqual(updates);
  // afterEach deleteDatabase also proves the rejected opener did not leak its late connection.
});

it('keeps the committed fence and legacy data after post-upgrade identity validation fails', async () => {
  const id = identity();
  const updates = source();
  (await legacy(id, updates)).close();
  await expect(IndexedDBActionJournal.open({ ...id, documentId: 'wrong' })).rejects.toThrow(
    'identity mismatch',
  );
  await expect(oldConnection(id)).rejects.toMatchObject({ name: 'VersionError' });
  const storage = await journal(id);
  expect(await storage.read()).toEqual(updates);
});

it.each(['no-event', 'mixed-message'])(
  'exports lossless rollback into a separate v1 namespace with %s pending structs and a tail',
  async (kind) => {
    const id = identity();
    const target = await open(id);
    const updates = source();
    const c = store();
    c.append(action(C));
    target.provider.receive(
      'peer',
      kind === 'no-event' ? updates[1] : Y.mergeUpdates([updates[1], c.encodeUpdate()]),
    );
    await target.provider.consolidate();
    target.value.append(action(B));
    await target.provider.flush();
    const sourceState = await target.storage.readCheckpoint();
    expect(sourceState.updates).toHaveLength(1);
    const tailOnly = store();
    for (const update of sourceState.updates) tailOnly.applyUpdate(update);
    expect(tailOnly.encodeUpdate()).not.toEqual(target.value.encodeUpdate());
    await target.provider.close();
    const sourceAgain = await journal(id);
    const capable = await restoreCheckpoint(sourceState.checkpoint!, store());
    stores.push(capable);
    for (const update of sourceState.updates) capable.applyUpdate(update);
    const destinationId = identity();
    (await legacy(destinationId, [capable.encodeUpdate()])).close();
    const old = await oldConnection(destinationId);
    const recovered = store();
    for (const update of await readLegacy(old)) recovered.applyUpdate(update);
    expect(recovered.encodeUpdate()).toEqual(capable.encodeUpdate());
    expect(recovered.snapshot()).toEqual(capable.snapshot());
    expect(await sourceAgain.readCheckpoint()).toEqual(sourceState);
    for (const value of [capable, recovered]) value.applyUpdate(updates[0]);
    expect(recovered.encodeUpdate()).toEqual(capable.encodeUpdate());
    expect(recovered.snapshot()).toEqual(capable.snapshot());
    expect(await sourceAgain.readCheckpoint()).toEqual(sourceState);
  },
);

it('reduces redundant stored batches without changing canonical byte categories across repeat consolidation', async () => {
  const id = identity();
  const target = await open(id);
  target.value.append(action());
  for (let i = 0; i < 20; i++) target.provider.receive('self-echo', target.value.encodeUpdate());
  await target.provider.flush();
  const canonical = target.value.retainedBytes();
  const before = journalBytes(await target.storage.readCheckpoint());
  await target.provider.consolidate();
  const after = journalBytes(await target.storage.readCheckpoint());
  expect(after.totalBytes).toBeLessThan(before.totalBytes);
  expect(after.batchCount).toBe(0);
  expect(target.value.retainedBytes()).toEqual(canonical);
  await target.provider.consolidate();
  await target.provider.close();
  const restored = await open(id);
  expect(restored.value.retainedBytes()).toEqual(canonical);
  expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
});
