import type { ActionJournal, JournalIdentity } from './types.js';

/** Append-only actionDoc journal. No BroadcastChannel or foreign-journal discovery. */
export class IndexedDBActionJournal implements ActionJournal {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(
    identity: JournalIdentity,
    factory: IDBFactory = indexedDB,
  ): Promise<IndexedDBActionJournal> {
    identity = { ...identity };
    if (!identity.namespace) throw new Error('A persistence namespace is required');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(`grain-actionDoc:${identity.namespace}`, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore('metadata');
        request.result.createObjectStore('updates', { autoIncrement: true });
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('IndexedDB open blocked'));
      };
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
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
      db.onversionchange = () => db.close();
      return new IndexedDBActionJournal(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  read(): Promise<readonly Uint8Array[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('updates', 'readonly');
      const request = transaction.objectStore('updates').getAll();
      transaction.oncomplete = () => {
        try {
          const updates: unknown[] = request.result;
          if (updates.some((update) => !(update instanceof Uint8Array)))
            throw new Error('IndexedDB journal contains a nonbinary update');
          resolve((updates as Uint8Array[]).map((update) => update.slice()));
        } catch (error) {
          reject(error);
        }
      };
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB read transaction aborted'));
    });
  }

  append(update: Uint8Array): Promise<void> {
    // Copy synchronously, before the caller can mutate its buffer.
    const copy = update.slice();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('updates', 'readwrite');
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
