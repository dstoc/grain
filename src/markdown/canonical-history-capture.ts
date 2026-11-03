import * as Y from 'yjs';

/**
 * Isolated native text history with explicit lifecycle ownership.
 *
 * Yjs 13.6.33 registers one `afterTransaction` callback per UndoManager. The
 * routed implementation below replaces those callbacks with one document
 * dispatcher. Keep all access to UndoManager.afterTransactionHandler here:
 * this is an adapter for the exact installed Yjs implementation.
 */
export interface NativeTextHistoryCapture {
  create(scope: readonly Y.AbstractType<any>[], origin: object): Y.UndoManager;
  dispose(manager: Y.UndoManager, origin: object): void;
  close(): void;
}

function makeManager(
  doc: Y.Doc,
  scope: readonly Y.AbstractType<any>[],
  origin: object,
): Y.UndoManager {
  let manager: Y.UndoManager;
  manager = new Y.UndoManager([...scope], {
    doc,
    captureTimeout: Number.POSITIVE_INFINITY,
    trackedOrigins: new Set([origin]),
    captureTransaction: (transaction) =>
      transaction.origin === origin || transaction.origin === manager,
  });
  return manager;
}

/** One writer-owned listener routes each transaction to its exact group. */
export class RoutedNativeTextHistoryCapture implements NativeTextHistoryCapture {
  private readonly managersByOrigin = new Map<object, Y.UndoManager>();
  private closed = false;

  private readonly dispatch = (transaction: Y.Transaction): void => {
    if (typeof transaction.origin !== 'object' || transaction.origin === null) return;
    this.managersByOrigin.get(transaction.origin)?.afterTransactionHandler(transaction);
  };

  constructor(private readonly doc: Y.Doc) {
    this.doc.on('afterTransaction', this.dispatch);
  }

  create(scope: readonly Y.AbstractType<any>[], origin: object): Y.UndoManager {
    if (this.closed) throw new Error('native text history capture is closed');
    if (this.managersByOrigin.has(origin))
      throw new Error('native text history origin is already registered');

    const manager = makeManager(this.doc, scope, origin);
    // The manager constructor attaches this exact callback. Replace it with
    // the one dispatcher registered by this adapter.
    this.doc.off('afterTransaction', manager.afterTransactionHandler);
    this.managersByOrigin.set(origin, manager);
    this.managersByOrigin.set(manager, manager);
    return manager;
  }

  dispose(manager: Y.UndoManager, origin: object): void {
    if (this.managersByOrigin.get(origin) === manager) this.managersByOrigin.delete(origin);
    if (this.managersByOrigin.get(manager) === manager) this.managersByOrigin.delete(manager);
    manager.destroy();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.doc.off('afterTransaction', this.dispatch);
    for (const manager of new Set(this.managersByOrigin.values())) manager.destroy();
    this.managersByOrigin.clear();
  }
}
