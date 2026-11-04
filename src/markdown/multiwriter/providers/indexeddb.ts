import type { CheckpointActionJournal, CheckpointJournalState, JournalIdentity } from './types.js';

/** Version-2 lossless journal. No BroadcastChannel or foreign-journal discovery. */
export class IndexedDBActionJournal implements CheckpointActionJournal {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(
    identity: JournalIdentity,
    factory: IDBFactory = indexedDB,
  ): Promise<IndexedDBActionJournal> {
    identity = { ...identity };
    if (!identity.namespace) throw new Error('A persistence namespace is required');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(`grain-actionDoc:${identity.namespace}`, 2);
      let blocked = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('metadata'))
          request.result.createObjectStore('metadata');
        if (!request.result.objectStoreNames.contains('updates'))
          request.result.createObjectStore('updates', { autoIncrement: true });
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('IndexedDB open blocked: close other connections before migration'));
      };
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
    db.onversionchange = () => db.close();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('metadata', 'readwrite');
        const metadata = transaction.objectStore('metadata');
        const request = metadata.get('identity');
        let mismatch = false;
        request.onsuccess = () => {
          const previous = request.result as JournalIdentity | undefined;
          if (!previous) metadata.add({ ...identity }, 'identity');
          else if (
            previous.namespace !== identity.namespace ||
            previous.protocolVersion !== identity.protocolVersion ||
            previous.documentId !== identity.documentId ||
            previous.genesisId !== identity.genesisId
          ) {
            mismatch = true;
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            mismatch
              ? new Error('Persistence namespace identity mismatch')
              : (transaction.error ?? new Error('IndexedDB metadata transaction aborted')),
          );
      });
      return new IndexedDBActionJournal(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async read(): Promise<readonly Uint8Array[]> {
    const state = await this.readCheckpoint();
    if ('checkpoint' in state) throw new Error('Checkpoint-aware read required');
    return state.updates;
  }

  readCheckpoint(): Promise<CheckpointJournalState> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['metadata', 'updates'], 'readonly');
      const updates = transaction.objectStore('updates').getAll();
      // A cursor distinguishes a missing key from a present undefined/corrupt record.
      const checkpoint = transaction
        .objectStore('metadata')
        .openCursor(IDBKeyRange.only('checkpoint'));
      transaction.oncomplete = () => {
        try {
          const values: unknown[] = updates.result;
          if (values.some((update) => !(update instanceof Uint8Array)))
            throw new Error('IndexedDB journal contains a nonbinary update');
          const result = { updates: (values as Uint8Array[]).map((update) => update.slice()) };
          if (!checkpoint.result) resolve(result);
          else {
            const bytes: unknown = checkpoint.result.value;
            if (!(bytes instanceof Uint8Array))
              throw new Error('IndexedDB contains an invalid checkpoint');
            resolve({ ...result, checkpoint: bytes.slice() });
          }
        } catch (error) {
          reject(error);
        }
      };
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB read transaction aborted'));
    });
  }

  replaceWithCheckpoint(checkpoint: Uint8Array): Promise<void> {
    const copy = checkpoint.slice();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['metadata', 'updates'], 'readwrite', {
        durability: 'strict',
      });
      try {
        transaction.objectStore('metadata').put(copy, 'checkpoint');
        transaction.objectStore('updates').clear();
      } catch (error) {
        transaction.abort();
        reject(error);
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB checkpoint transaction aborted'));
    });
  }

  append(update: Uint8Array): Promise<void> {
    // Copy synchronously, before the caller can mutate its buffer.
    const copy = update.slice();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('updates', 'readwrite', { durability: 'strict' });
      transaction.objectStore('updates').add(copy);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB write transaction aborted'));
    });
  }

  close(): void {
    this.db.close();
  }
}
