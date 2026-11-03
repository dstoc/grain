import * as Y from 'yjs';

import {
  addHistoryTapesToScope,
  closeHistoryEntry,
  destroyHistoryEntry,
  historyScope,
  makeTextHistoryManager,
} from '../history.js';
import type {
  ActionFocusAnchors,
  HistoryEntry,
  HistoryReservation,
  SessionHistory,
} from '../history.js';
import { currentActive } from '../state-access.js';
import type { TapeId } from '../types.js';
import type { NativeTextHistoryCapture } from '../../canonical-history-capture.js';
import type { ActionReceipt, CanonicalTextAnchor, StructuralPatch } from '../action-types.js';
import type { NodeId } from '../../semantic/types.js';

export interface HistorySelection {
  readonly index?: number;
  readonly entry?: HistoryEntry;
  readonly reason?: 'invalid-scope' | 'mixed-scope';
}

/** Owns per-session history groups, native capture reservations, and eviction. */
export class CanonicalHistoryCoordinator {
  private readonly sessions = new Map<string, SessionHistory>();
  private sequenceOrdinal = 0;

  constructor(
    private readonly state: Y.Doc,
    private readonly historyCapture: NativeTextHistoryCapture,
    private readonly maxHistoryGroups: number,
  ) {}

  admit(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { undo: [], redo: [], all: new Set() });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  close(): void {
    for (const session of this.sessions.values()) {
      for (const entry of session.all) destroyHistoryEntry(entry, this.historyCapture);
      session.all.clear();
      session.undo.length = 0;
      session.redo.length = 0;
      session.current = undefined;
    }
    this.sessions.clear();
  }

  sealTextGroup(sessionId: string): void {
    const current = this.sessions.get(sessionId)?.current;
    if (!current) return;
    closeHistoryEntry(current);
    const session = this.sessions.get(sessionId)!;
    session.current = undefined;
  }

  reserve(
    sessionId: string,
    groupId: string,
    noEffect: boolean,
    structuralEffect: boolean,
    textTapes: readonly TapeId[],
    receipt: ActionReceipt,
    structuralPatch: StructuralPatch,
    focusAnchors?: ActionFocusAnchors,
    selectionAnchors?: {
      readonly anchor: CanonicalTextAnchor;
      readonly focus: CanonicalTextAnchor;
    },
  ): HistoryReservation {
    const session = this.getSession(sessionId);
    const current = session.current;
    const sameTextTarget =
      current?.touchedNodeIds.length === 1 &&
      receipt.touchedNodeIds.length === 1 &&
      current.touchedNodeIds[0] === receipt.touchedNodeIds[0];
    const canJoin =
      !noEffect &&
      !structuralEffect &&
      textTapes.length > 0 &&
      current?.groupId === groupId &&
      !current.sealed &&
      sameTextTarget;
    if (canJoin) {
      const entry = current!;
      return {
        sessionId,
        entry,
        isNew: false,
        managerExisted: !!entry.manager,
        nextCurrent: true,
        noEffect,
        structuralEffect,
        textTapes,
        structuralPatch,
        ...(receipt.focus ? { focus: receipt.focus } : {}),
        ...(focusAnchors ? { focusAnchors } : {}),
        ...(selectionAnchors ? { selectionAnchors } : {}),
      };
    }
    const entryId = noEffect
      ? `${groupId}:noop:${receipt.requestId}`
      : `${groupId}:${receipt.requestId}`;
    const entry: HistoryEntry = {
      id: entryId,
      sessionId,
      groupId,
      createdSequence: this.sequenceOrdinal,
      origin: Object.freeze({ entryId }),
      textTapes: new Set(textTapes),
      touchedNodeIds: receipt.touchedNodeIds,
      touchedTapeIds: receipt.touchedTapeIds,
      structuralPatch,
      ...(receipt.focus ? { focus: receipt.focus } : {}),
      ...(focusAnchors ? { focusAnchors } : {}),
      ...(selectionAnchors ? { selectionAnchors } : {}),
      sealed: noEffect || structuralEffect,
      noEffect,
      structuralEffect,
      actionCount: 0,
    };
    return {
      sessionId,
      entry,
      isNew: true,
      managerExisted: false,
      nextCurrent: !noEffect && !structuralEffect && textTapes.length > 0,
      noEffect,
      structuralEffect,
      textTapes,
      structuralPatch,
      ...(receipt.focus ? { focus: receipt.focus } : {}),
      ...(focusAnchors ? { focusAnchors } : {}),
      ...(selectionAnchors ? { selectionAnchors } : {}),
    };
  }

  activate(reservation: HistoryReservation): void {
    const entry = reservation.entry;
    if (!reservation.textTapes.length) return;
    if (!entry.manager) {
      const tapeIds = [...new Set([...entry.textTapes, ...reservation.textTapes])];
      entry.manager = makeTextHistoryManager(this.state, entry, tapeIds, this.historyCapture);
    } else if (!reservation.isNew) {
      addHistoryTapesToScope(this.state, entry, reservation.textTapes);
    }
  }

  addTapesToScope(entry: HistoryEntry, tapeIds: readonly TapeId[]): void {
    addHistoryTapesToScope(this.state, entry, tapeIds);
  }

  cancel(reservation: HistoryReservation): void {
    if (reservation.isNew || !reservation.managerExisted) {
      destroyHistoryEntry(reservation.entry, this.historyCapture);
    }
  }

  finish(reservation: HistoryReservation): void {
    const session = this.getSession(reservation.sessionId);
    for (const redo of session.redo.splice(0)) {
      session.all.delete(redo);
      destroyHistoryEntry(redo, this.historyCapture);
    }
    const entry = reservation.entry;
    if (reservation.isNew) {
      if (session.current && session.current !== entry) closeHistoryEntry(session.current);
      if (session.current !== entry) session.current = undefined;
      this.sequenceOrdinal++;
      session.undo.push(entry);
      session.all.add(entry);
    }
    if (!reservation.isNew && reservation.focus) {
      entry.focus = Object.freeze({
        ...((entry.focus?.start ?? reservation.focus.start)
          ? { start: entry.focus?.start ?? reservation.focus.start }
          : {}),
        ...(reservation.focus.end ? { end: reservation.focus.end } : {}),
      });
    }
    if (!reservation.isNew && reservation.focusAnchors) {
      entry.focusAnchors = Object.freeze({
        ...((entry.focusAnchors?.start ?? reservation.focusAnchors.start)
          ? { start: entry.focusAnchors?.start ?? reservation.focusAnchors.start }
          : {}),
        ...(reservation.focusAnchors.end ? { end: reservation.focusAnchors.end } : {}),
      });
    }
    if (reservation.selectionAnchors) entry.selectionAnchors = reservation.selectionAnchors;
    for (const tapeId of reservation.textTapes) entry.textTapes.add(tapeId);
    entry.noEffect &&= reservation.noEffect;
    entry.structuralEffect ||= reservation.structuralEffect;
    entry.actionCount++;
    if (reservation.nextCurrent) session.current = entry;
    else {
      if (session.current === entry) session.current = undefined;
      closeHistoryEntry(entry);
    }
    for (const [otherSessionId, other] of this.sessions.entries()) {
      if (otherSessionId !== reservation.sessionId && other.current) {
        closeHistoryEntry(other.current);
        other.current = undefined;
      }
    }
    this.trimHistory(session);
  }

  select(sessionId: string, direction: 'undo' | 'redo', scopeRoot?: NodeId): HistorySelection {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    const source = direction === 'undo' ? session.undo : session.redo;
    if (scopeRoot !== undefined && !currentActive(this.state, scopeRoot)) {
      return { reason: 'invalid-scope' };
    }
    for (let index = source.length - 1; index >= 0; index--) {
      if (scopeRoot === undefined) return { index, entry: source[index]! };
      const entry = source[index]!;
      const scope = historyScope(this.state, entry, scopeRoot);
      if (scope === 'outside') continue;
      if (scope === 'mixed') return { reason: 'mixed-scope' };
      return { index, entry };
    }
    return {};
  }

  moveSelected(
    sessionId: string,
    direction: 'undo' | 'redo',
    index: number,
    entry: HistoryEntry,
  ): void {
    const session = this.getSession(sessionId);
    const source = direction === 'undo' ? session.undo : session.redo;
    const destination = direction === 'undo' ? session.redo : session.undo;
    assert(source[index] === entry, 'selected history entry is no longer current');
    source.splice(index, 1);
    destination.push(entry);
    if (session.current === entry) session.current = undefined;
  }

  private trimHistory(session: SessionHistory): void {
    while (session.all.size > this.maxHistoryGroups) {
      const oldest = [...session.all].sort((a, b) => a.createdSequence - b.createdSequence)[0];
      if (!oldest) return;
      session.all.delete(oldest);
      session.undo.splice(session.undo.indexOf(oldest), session.undo.includes(oldest) ? 1 : 0);
      session.redo.splice(session.redo.indexOf(oldest), session.redo.includes(oldest) ? 1 : 0);
      if (session.current === oldest) session.current = undefined;
      destroyHistoryEntry(oldest, this.historyCapture);
    }
  }

  private getSession(sessionId: string): SessionHistory {
    const session = this.sessions.get(sessionId);
    assert(session, `session ${sessionId} has not been admitted by the host`);
    return session;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
