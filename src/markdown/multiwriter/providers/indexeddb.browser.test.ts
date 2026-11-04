import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ActionStore } from '../actions/store.js';
import { action, A, B, C } from '../actions/test-fixtures.js';
import type { DeliveryRoute, SyncMode } from '../contracts.js';
import { DirectionalActionProvider } from './adapter.js';
import { IndexedDBActionJournal } from './indexeddb.js';
import type { JournalIdentity } from './types.js';

const databases: string[] = [];
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
    validate: () => null,
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
    const request = indexedDB.open(`grain-actionDoc:${id.namespace}`, 1);
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
    const request = indexedDB.open(`grain-actionDoc:${id.namespace}`, 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  await expect(IndexedDBActionJournal.open(id)).rejects.toMatchObject({ name: 'VersionError' });
});
