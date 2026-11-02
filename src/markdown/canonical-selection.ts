import * as Y from 'yjs';

import { canonicalWriterAccess, CanonicalDocument, CanonicalNode } from './canonical-model.js';
import type { NodeId, Span, TapeId } from './canonical-model.js';
import type { Bookmark } from './canonical-actions.js';
import { mapTextEdit } from './canonical-text.js';

export interface CanonicalTextAnchor {
  readonly bookmark: Bookmark;
  readonly tapeId: TapeId;
  readonly relativePosition: readonly number[];
  readonly previousNodeId?: NodeId;
  readonly nextNodeId?: NodeId;
}

interface IndexedSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Captures a transient Yjs text anchor plus the structural fallback order. */
export function createCanonicalTextAnchor(
  document: CanonicalDocument,
  bookmark: Bookmark,
): CanonicalTextAnchor {
  document.assertReadable();
  return createCanonicalTextAnchorFromState(canonicalWriterAccess(document).state, bookmark);
}

/** @internal Capture history focus while a candidate state is being validated. */
export function createCanonicalTextAnchorFromState(
  state: Y.Doc,
  bookmark: Bookmark,
): CanonicalTextAnchor {
  const record = state.getMap<Y.Map<unknown>>('nodes').get(bookmark.nodeId);
  if (!record) throw new Error(`unknown bookmark node ${bookmark.nodeId}`);
  const spansCell = record.get('spans') as { readonly value: readonly Span[] } | undefined;
  if (!spansCell || !Array.isArray(spansCell.value)) {
    throw new Error(`bookmark node ${bookmark.nodeId} has no spans`);
  }
  const tapes = state.getMap<Y.Text>('tapes');
  const tapeMap = new Map(tapes.entries());
  const projectedText = spansCell.value.map((span) => spanText(tapeMap, span)).join('');
  const adjustedBookmark = {
    ...bookmark,
    offset: clampUtf16(projectedText, bookmark.offset, bookmark.affinity),
  };
  const mapped = mapTextEdit(spansCell.value, tapeMap, {
    from: adjustedBookmark.offset,
    to: adjustedBookmark.offset,
    insert: '',
    affinity: adjustedBookmark.affinity,
    spanIndex: adjustedBookmark.spanIndex,
  });
  const tape = tapes.get(mapped.insertion.tapeId);
  if (!tape) throw new Error(`missing bookmark tape ${mapped.insertion.tapeId}`);
  const relativePosition = Y.createRelativePositionFromTypeIndex(
    tape,
    mapped.insertion.index,
    adjustedBookmark.affinity === 'left' ? -1 : 1,
  );
  const visible = visibleInlineNodeIds(state);
  const index = visible.indexOf(bookmark.nodeId);
  return Object.freeze({
    bookmark: Object.freeze(adjustedBookmark),
    tapeId: mapped.insertion.tapeId,
    relativePosition: Object.freeze([...Y.encodeRelativePosition(relativePosition)]),
    ...(index > 0 ? { previousNodeId: visible[index - 1]! } : {}),
    ...(index >= 0 && index + 1 < visible.length ? { nextNodeId: visible[index + 1]! } : {}),
  });
}

/** Resolves a text anchor through current ownership, with deterministic hidden-node fallback. */
export function resolveCanonicalTextAnchor(
  document: CanonicalDocument,
  anchor: CanonicalTextAnchor,
): Bookmark {
  document.assertReadable();
  const state = canonicalWriterAccess(document).state;
  const tapes = state.getMap<Y.Text>('tapes');
  const tapeMap = new Map(tapes.entries());
  const tape = tapes.get(anchor.tapeId);
  const relative = Y.decodeRelativePosition(Uint8Array.from(anchor.relativePosition));
  const absolute = Y.createAbsolutePositionFromRelativePosition(relative, state, false);
  if (tape && absolute?.type === tape) {
    const visible = visibleInlineNodes(document.root);
    const candidates: Array<{ node: CanonicalNode; offset: number }> = [];
    for (const node of visible) {
      const record = state.getMap<Y.Map<unknown>>('nodes').get(node.sharedId);
      const spans = (record?.get('spans') as { readonly value: readonly Span[] } | undefined)
        ?.value;
      if (!spans) continue;
      let baseOffset = 0;
      for (const span of spans) {
        if (span.tapeId === anchor.tapeId) {
          const indexed = indexSpan(tape, span);
          if (absolute.index >= indexed.start && absolute.index <= indexed.end) {
            const nodeText = node.content ?? '';
            candidates.push({
              node,
              offset: clampUtf16(
                nodeText,
                baseOffset + offsetAt(tape, span, absolute.index),
                anchor.bookmark.affinity,
              ),
            });
          }
        }
        baseOffset += spanText(tapeMap, span).length;
      }
    }
    if (candidates.length) {
      const preferred = candidates.find((item) => item.node.sharedId === anchor.bookmark.nodeId);
      const chosen =
        preferred ?? (anchor.bookmark.affinity === 'left' ? candidates.at(-1) : candidates[0])!;
      return { ...anchor.bookmark, nodeId: chosen.node.sharedId, offset: chosen.offset };
    }
  }

  const visible = visibleInlineNodes(document.root);
  const activeFallback = visible.find((node) => node.sharedId === anchor.bookmark.nodeId);
  if (activeFallback) {
    return {
      ...anchor.bookmark,
      offset: clampUtf16(
        activeFallback.content ?? '',
        anchor.bookmark.offset,
        anchor.bookmark.affinity,
      ),
    };
  }
  const neighbour = [anchor.nextNodeId, anchor.previousNodeId]
    .filter((id): id is NodeId => id !== undefined)
    .map((id) => visible.find((node) => node.sharedId === id))
    .find((node): node is CanonicalNode => !!node);
  if (neighbour) {
    return {
      ...anchor.bookmark,
      nodeId: neighbour.sharedId,
      offset: clampUtf16(neighbour.content ?? '', anchor.bookmark.offset, anchor.bookmark.affinity),
    };
  }
  const first = visible[0];
  if (first) return { ...anchor.bookmark, nodeId: first.sharedId, offset: 0 };
  return anchor.bookmark;
}

function visibleInlineNodes(root: CanonicalNode): CanonicalNode[] {
  const result: CanonicalNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block') {
      result.push(node);
    }
    pending.push(...[...node.children].reverse());
  }
  return result;
}

function visibleInlineNodeIds(state: Y.Doc): NodeId[] {
  const meta = state.getMap<unknown>('meta');
  const rootId = meta.get('rootId');
  if (typeof rootId !== 'string') return [];
  const nodes = state.getMap<Y.Map<unknown>>('nodes');
  const result: NodeId[] = [];
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    const record = nodes.get(id);
    if (!record) continue;
    const kind = (record.get('kind') as { readonly value?: unknown } | undefined)?.value;
    if (kind === 'paragraph' || kind === 'section' || kind === 'code-block') result.push(id);
    const children = (record.get('children') as { readonly value?: unknown } | undefined)?.value;
    if (Array.isArray(children)) pending.push(...[...children].reverse());
  }
  return result;
}

function spanText(tapes: ReadonlyMap<TapeId, Y.Text>, span: Span): string {
  const tape = tapes.get(span.tapeId);
  if (!tape) throw new Error(`missing bookmark tape ${span.tapeId}`);
  let inside = false;
  let content = '';
  for (const part of tape.toDelta()) {
    const insert = part.insert;
    if (typeof insert === 'string') {
      if (inside) content += insert;
      continue;
    }
    const boundary =
      insert !== null && typeof insert === 'object' && 'grainBoundary' in insert
        ? (insert as { readonly grainBoundary: unknown }).grainBoundary
        : undefined;
    if (boundary === span.startBoundaryId) inside = true;
    else if (boundary === span.endBoundaryId) break;
  }
  return content;
}

function indexSpan(tape: Y.Text, span: Span): IndexedSpan {
  let index = 0;
  let start: number | undefined;
  let end: number | undefined;
  let text = '';
  for (const part of tape.toDelta()) {
    const insert = part.insert;
    if (typeof insert === 'string') {
      if (start !== undefined && end === undefined) text += insert;
      index += insert.length;
      continue;
    }
    const boundary =
      insert !== null && typeof insert === 'object' && 'grainBoundary' in insert
        ? (insert as { readonly grainBoundary: unknown }).grainBoundary
        : undefined;
    if (boundary === span.startBoundaryId) start = index + 1;
    else if (boundary === span.endBoundaryId) {
      end = index;
      break;
    }
    index++;
  }
  if (start === undefined || end === undefined) throw new Error('bookmark span is unresolved');
  return { start, end, text };
}

function offsetAt(tape: Y.Text, span: Span, absoluteIndex: number): number {
  let nativeIndex = 0;
  let visibleOffset = 0;
  let inside = false;
  for (const part of tape.toDelta()) {
    const insert = part.insert;
    if (typeof insert === 'string') {
      if (inside) {
        const local = Math.max(0, Math.min(insert.length, absoluteIndex - nativeIndex));
        if (absoluteIndex <= nativeIndex + insert.length) return visibleOffset + local;
        visibleOffset += insert.length;
      }
      nativeIndex += insert.length;
      continue;
    }
    const boundary =
      insert !== null && typeof insert === 'object' && 'grainBoundary' in insert
        ? (insert as { readonly grainBoundary: unknown }).grainBoundary
        : undefined;
    if (boundary === span.startBoundaryId) inside = true;
    else if (boundary === span.endBoundaryId) return visibleOffset;
    nativeIndex++;
  }
  return visibleOffset;
}

function clampUtf16(text: string, offset: number, affinity: Bookmark['affinity']): number {
  const clamped = Math.max(0, Math.min(text.length, offset));
  if (clamped > 0 && clamped < text.length) {
    const before = text.charCodeAt(clamped - 1);
    const after = text.charCodeAt(clamped);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      return affinity === 'left' ? clamped - 1 : clamped + 1;
    }
  }
  return clamped;
}
