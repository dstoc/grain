import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  RoutedNativeTextHistoryCapture,
  type NativeTextHistoryCapture,
} from './canonical-history-capture.js';
import { ReferenceNativeTextHistoryCapture } from './canonical-history-capture.reference.js';

type CaptureMode = 'routed' | 'reference';
type Listener = (...args: any[]) => void;

function makeCapture(mode: CaptureMode, doc: Y.Doc): NativeTextHistoryCapture {
  return mode === 'routed'
    ? new RoutedNativeTextHistoryCapture(doc)
    : new ReferenceNativeTextHistoryCapture(doc);
}

function observeAfterTransactionListeners(doc: Y.Doc) {
  const active = new Set<Listener>();
  const wrappers = new Map<Listener, Listener>();
  let callbackInvocations = 0;
  const originalOn = doc.on;
  const originalOff = doc.off;
  const callOn = originalOn.bind(doc) as (name: string, listener: Listener) => void;
  const callOff = originalOff.bind(doc) as (name: string, listener: Listener) => void;

  doc.on = ((name: string, listener: Listener) => {
    if (name !== 'afterTransaction') {
      callOn(name, listener);
      return;
    }
    let wrapper = wrappers.get(listener);
    if (!wrapper) {
      wrapper = (...args: any[]) => {
        callbackInvocations++;
        listener(...args);
      };
      wrappers.set(listener, wrapper);
    }
    active.add(listener);
    callOn(name, wrapper);
  }) as typeof doc.on;
  doc.off = ((name: string, listener: Listener) => {
    if (name === 'afterTransaction') {
      const wrapper = wrappers.get(listener);
      if (wrapper) {
        active.delete(listener);
        callOff(name, wrapper);
        return;
      }
    }
    callOff(name, listener);
  }) as typeof doc.off;

  return {
    get activeCount() {
      return active.size;
    },
    get callbackInvocations() {
      return callbackInvocations;
    },
    restore() {
      doc.on = originalOn;
      doc.off = originalOff;
    },
  };
}

function runSplitJoinAndDeletionTrace(mode: CaptureMode) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 0x55aa;
  const left = doc.getText('left');
  const right = doc.getText('right');
  left.insert(0, 'abc');
  right.insert(0, 'def');
  const capture = makeCapture(mode, doc);
  const firstOrigin = {};
  const interleavedOrigin = {};
  const noEffectOrigin = {};
  const first = capture.create([left], firstOrigin);
  const interleaved = capture.create([left], interleavedOrigin);
  const noEffect = capture.create([left], noEffectOrigin);

  // The logical group starts on the left tape, then continues on the right
  // after a split. The later undo/redo runs with both tapes in scope, as after
  // those spans are joined under one node again.
  doc.transact(() => left.insert(2, '@'), firstOrigin);
  doc.transact(() => left.delete(3, 1), interleavedOrigin);
  first.addToScope([right]);
  doc.transact(() => right.insert(0, '#'), firstOrigin);
  const afterInput = [left.toString(), right.toString()];
  const firstUndoDepth = first.undoStack.length;
  const interleavedUndoDepth = interleaved.undoStack.length;

  first.undo();
  const afterFirstUndo = [left.toString(), right.toString()];
  interleaved.undo();
  const afterInterleavedUndo = [left.toString(), right.toString()];
  first.redo();
  const afterFirstRedo = [left.toString(), right.toString()];
  interleaved.redo();
  const afterInterleavedRedo = [left.toString(), right.toString()];

  const beforeNoEffect = [left.toString(), right.toString()];
  doc.transact(() => {}, noEffectOrigin);
  const noEffectDepth = noEffect.undoStack.length;
  if (noEffect.canUndo()) noEffect.undo();

  const result = {
    afterInput,
    firstUndoDepth,
    interleavedUndoDepth,
    afterFirstUndo,
    afterInterleavedUndo,
    afterFirstRedo,
    afterInterleavedRedo,
    noEffectDepth,
    noEffectPreservedText:
      beforeNoEffect[0] === left.toString() && beforeNoEffect[1] === right.toString(),
    update: Y.encodeStateAsUpdate(doc),
  };

  capture.close();
  doc.destroy();
  return result;
}

function runListenerAblation(mode: CaptureMode, groupCount: number) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 0x55bb;
  const text = doc.getText('content');
  const probe = observeAfterTransactionListeners(doc);
  const capture = makeCapture(mode, doc);
  const managers: Y.UndoManager[] = [];
  const origins: object[] = [];

  for (let index = 0; index < groupCount; index++) {
    const origin = {};
    origins.push(origin);
    managers.push(capture.create([text], origin));
  }
  for (const origin of origins) {
    doc.transact(() => text.insert(text.length, 'x'), origin);
  }

  const result = {
    activeListeners: probe.activeCount,
    listenerInvocations: probe.callbackInvocations,
    allGroupsHaveOneNativeItem: managers.every((manager) => manager.undoStack.length === 1),
    textLength: text.length,
    update: Y.encodeStateAsUpdate(doc),
  };
  capture.close();
  probe.restore();
  doc.destroy();
  return result;
}

describe('canonical native history capture adapter', () => {
  it('routes exact forward and inverse origins and releases evicted groups', () => {
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText('content');
    const probe = observeAfterTransactionListeners(doc);
    const capture = new RoutedNativeTextHistoryCapture(doc);
    const firstOrigin = {};
    const secondOrigin = {};
    const first = capture.create([text], firstOrigin);
    const second = capture.create([text], secondOrigin);

    expect(probe.activeCount).toBe(1);
    doc.transact(() => text.insert(0, 'a'), { ...firstOrigin });
    expect(first.undoStack).toHaveLength(0);
    expect(second.undoStack).toHaveLength(0);
    doc.transact(() => text.insert(1, 'b'), firstOrigin);
    expect(first.undoStack).toHaveLength(1);
    expect(second.undoStack).toHaveLength(0);

    first.undo();
    expect(text.toString()).toBe('a');
    expect(first.redoStack).toHaveLength(1);
    expect(second.redoStack).toHaveLength(0);

    const firstUndoDepth = first.undoStack.length;
    capture.dispose(first, firstOrigin);
    doc.transact(() => text.insert(text.length, 'c'), firstOrigin);
    expect(first.undoStack).toHaveLength(firstUndoDepth);
    expect(second.undoStack).toHaveLength(0);
    expect(probe.activeCount).toBe(1);

    capture.dispose(second, secondOrigin);
    capture.close();
    expect(probe.activeCount).toBe(0);
    probe.restore();
    doc.destroy();
  });

  it('matches always-attached Yjs history across split scope and interleaved deletion', () => {
    const routed = runSplitJoinAndDeletionTrace('routed');
    const reference = runSplitJoinAndDeletionTrace('reference');

    expect(routed).toEqual(reference);
    expect(routed.afterInput).toEqual(['ab@', '#def']);
    expect(routed.firstUndoDepth).toBe(1);
    expect(routed.interleavedUndoDepth).toBe(1);
    expect(routed.afterFirstUndo).toEqual(['ab', 'def']);
    expect(routed.afterInterleavedUndo).toEqual(['abc', 'def']);
    expect(routed.afterFirstRedo).toEqual(['ab@c', '#def']);
    expect(routed.afterInterleavedRedo).toEqual(['ab@', '#def']);
    expect(routed.noEffectDepth).toBe(0);
    expect(routed.noEffectPreservedText).toBe(true);
  });

  it.each([
    ['routed', 1],
    ['reference', 0],
  ] as const)(
    'disposes a group without recapturing later edits in %s mode',
    (mode, listenersAfterDispose) => {
      const doc = new Y.Doc({ gc: false });
      const text = doc.getText('content');
      const probe = observeAfterTransactionListeners(doc);
      const capture = makeCapture(mode, doc);
      const origin = {};
      const manager = capture.create([text], origin);

      doc.transact(() => text.insert(0, 'a'), origin);
      expect(manager.undoStack).toHaveLength(1);
      capture.dispose(manager, origin);
      expect(probe.activeCount).toBe(listenersAfterDispose);
      doc.transact(() => text.insert(1, 'b'), origin);
      expect(manager.undoStack).toHaveLength(1);

      capture.close();
      expect(probe.activeCount).toBe(0);
      probe.restore();
      doc.destroy();
    },
  );

  it('removes callback fan-out while retaining identical native history state', () => {
    for (const groupCount of [64, 500]) {
      const reference = runListenerAblation('reference', groupCount);
      const routed = runListenerAblation('routed', groupCount);

      expect(routed.update).toEqual(reference.update);
      expect(routed.allGroupsHaveOneNativeItem).toBe(true);
      expect(reference.allGroupsHaveOneNativeItem).toBe(true);
      expect(routed.textLength).toBe(groupCount);
      expect(reference.textLength).toBe(groupCount);
      expect(reference.activeListeners).toBe(groupCount);
      expect(routed.activeListeners).toBe(1);
      expect(reference.listenerInvocations).toBe(groupCount * groupCount);
      expect(routed.listenerInvocations).toBe(groupCount);
    }
  });
});
