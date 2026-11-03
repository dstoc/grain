import * as Y from 'yjs';

import type { NativeTextHistoryCapture } from './canonical-history-capture.js';

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

/** Always-attached Yjs reference used only by installed-package differential tests. */
export class ReferenceNativeTextHistoryCapture implements NativeTextHistoryCapture {
  private readonly managers = new Set<Y.UndoManager>();
  private closed = false;

  constructor(private readonly doc: Y.Doc) {}

  create(scope: readonly Y.AbstractType<any>[], origin: object): Y.UndoManager {
    if (this.closed) throw new Error('native text history capture is closed');
    const manager = makeManager(this.doc, scope, origin);
    this.managers.add(manager);
    return manager;
  }

  dispose(manager: Y.UndoManager, _origin: object): void {
    this.managers.delete(manager);
    manager.destroy();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const manager of this.managers) manager.destroy();
    this.managers.clear();
  }
}
