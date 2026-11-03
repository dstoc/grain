import * as Y from 'yjs';

import { currentActive, metaMap, nodeMap, readCell, revisionMap, tapeMap } from './state-access.js';
import type { Span, TapeId } from './types.js';
import type { NodeId } from '../semantic/types.js';
import type {
  ActionFocus,
  Bookmark,
  CanonicalTextAnchor,
  PendingHistoryCommit,
  StructuralPatch,
} from './action-types.js';
import type { NativeMutationEvidence } from './native-execution.js';
import type { NativeTextHistoryCapture } from '../canonical-history-capture.js';

export interface HistoryEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly groupId: string;
  readonly createdSequence: number;
  readonly origin: object;
  readonly textTapes: Set<TapeId>;
  readonly touchedNodeIds: readonly NodeId[];
  readonly touchedTapeIds: readonly TapeId[];
  structuralPatch: StructuralPatch;
  focus?: ActionFocus;
  focusAnchors?: ActionFocusAnchors;
  selectionAnchors?: { readonly anchor: CanonicalTextAnchor; readonly focus: CanonicalTextAnchor };
  manager?: Y.UndoManager;
  sealed: boolean;
  noEffect: boolean;
  structuralEffect: boolean;
  actionCount: number;
}

export interface ActionFocusAnchors {
  readonly start?: CanonicalTextAnchor;
  readonly end?: CanonicalTextAnchor;
}

export function historyFocus(
  entry: HistoryEntry,
  direction: 'undo' | 'redo',
): Bookmark | undefined {
  return direction === 'undo' ? entry.focus?.start : entry.focus?.end;
}

export function historyFocusAnchor(
  entry: HistoryEntry,
  direction: 'undo' | 'redo',
): CanonicalTextAnchor | undefined {
  return direction === 'undo' ? entry.focusAnchors?.start : entry.focusAnchors?.end;
}

export function historySelectionAnchors(entry: HistoryEntry, direction: 'undo' | 'redo') {
  return direction === 'undo' || entry.focus?.selection?.restoreOnRedo
    ? entry.selectionAnchors
    : undefined;
}

type HistoryScope = 'inside' | 'outside' | 'mixed';

export function historyScope(state: Y.Doc, entry: HistoryEntry, scopeRoot: NodeId): HistoryScope {
  const scopeNodes = new Set<NodeId>();
  const pending = [scopeRoot];
  while (pending.length) {
    const id = pending.pop()!;
    if (scopeNodes.has(id)) continue;
    scopeNodes.add(id);
    const record = nodeMap(state).get(id);
    if (record) pending.push(...readCell<readonly NodeId[]>(record, 'children').value);
  }

  let inside = false;
  let outside = false;
  const add = (id: NodeId) => {
    if (scopeNodes.has(id)) inside = true;
    else outside = true;
  };
  // Node IDs describe structural participants, but a text-only edit's original
  // node may since have been detached by a join. Scope its text through the
  // current active owners of the tape instead.
  if (entry.structuralEffect) {
    for (const id of entry.touchedNodeIds) add(id);
  }

  const touchedTapes = new Set(entry.touchedTapeIds);
  if (touchedTapes.size) {
    for (const [id, record] of nodeMap(state)) {
      if (!currentActive(state, id)) continue;
      const spans = readCell<readonly Span[]>(record, 'spans').value;
      if (spans.some((span) => touchedTapes.has(span.tapeId))) add(id);
    }
  }
  if (!inside && !outside) return 'inside';
  return inside && outside ? 'mixed' : inside ? 'inside' : 'outside';
}

export interface SessionHistory {
  sequence: number;
  readonly undo: HistoryEntry[];
  readonly redo: HistoryEntry[];
  readonly all: Set<HistoryEntry>;
  current?: HistoryEntry;
}

export interface HistoryReservation {
  readonly sessionId: string;
  readonly entry: HistoryEntry;
  readonly isNew: boolean;
  readonly managerExisted: boolean;
  readonly nextCurrent: boolean;
  readonly noEffect: boolean;
  readonly structuralEffect: boolean;
  readonly textTapes: readonly TapeId[];
  readonly structuralPatch: StructuralPatch;
  readonly focus?: ActionFocus;
  readonly focusAnchors?: ActionFocusAnchors;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
}

export interface PendingHistoryRecord {
  readonly publicValue: PendingHistoryCommit;
  readonly sessionId: string;
  readonly direction: 'undo' | 'redo';
  readonly entry: HistoryEntry;
  readonly sourceIndex: number;
  readonly revision: number;
  readonly textChanged: boolean;
  readonly focus?: Bookmark;
  readonly focusAnchor?: CanonicalTextAnchor;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
  readonly update: Uint8Array;
}

export function makeTextHistoryManager(
  state: Y.Doc,
  entry: HistoryEntry,
  tapeIds: readonly TapeId[],
  historyCapture: NativeTextHistoryCapture,
): Y.UndoManager {
  const tapes = tapeMap(state);
  const scope = tapeIds.flatMap((id) => {
    const tape = tapes.get(id);
    return tape ? [tape] : [];
  });
  return historyCapture.create(scope, entry.origin);
}

export function addHistoryTapesToScope(
  state: Y.Doc,
  entry: HistoryEntry,
  tapeIds: readonly TapeId[],
): void {
  if (!entry.manager) return;
  const tapes = tapeMap(state);
  const scope = tapeIds.flatMap((id) => {
    const tape = tapes.get(id);
    return tape ? [tape] : [];
  });
  if (scope.length) entry.manager.addToScope(scope);
}

export function closeHistoryEntry(entry: HistoryEntry): void {
  entry.sealed = true;
  entry.manager?.stopCapturing();
}

export function destroyHistoryEntry(
  entry: HistoryEntry,
  historyCapture: NativeTextHistoryCapture,
): void {
  if (!entry.manager) return;
  historyCapture.dispose(entry.manager, entry.origin);
  delete entry.manager;
}

export function updateRevisionsAfterHistory(
  state: Y.Doc,
  mutations: NativeMutationEvidence,
  structuralEffect = false,
): { revision: number; changed: TapeId[] } {
  const changed = [...mutations.changedTapeIds];
  if (!changed.length && !structuralEffect)
    return { revision: metaMap(state).get('acceptedRevision') as number, changed };
  const revision = (metaMap(state).get('acceptedRevision') as number) + 1;
  state.transact(() => {
    for (const id of changed) revisionMap(state).set(id, revision);
    metaMap(state).set('acceptedRevision', revision);
  }, 'grain:history-revision');
  return { revision, changed };
}
