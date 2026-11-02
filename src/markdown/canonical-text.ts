import * as Y from 'yjs';

import type { BoundaryEmbed, Span, TapeId } from './canonical-model.js';

export type TextAffinity = 'left' | 'right';

export interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly affinity?: TextAffinity;
  /** Select an otherwise empty span when a bookmark resolves to one explicitly. */
  readonly spanIndex?: number;
}

export interface NativeTextRun {
  readonly tapeId: TapeId;
  readonly from: number;
  readonly to: number;
}

export interface NativeInsertionPoint {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly spanIndex: number;
  readonly affinity: TextAffinity;
}

export interface MappedTextEdit {
  readonly projectedText: string;
  readonly deletions: readonly NativeTextRun[];
  readonly insertion: NativeInsertionPoint;
}

interface TextRun {
  readonly from: number;
  readonly to: number;
  readonly nativeFrom: number;
}

interface SpanIndex {
  readonly span: Span;
  readonly spanIndex: number;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly text: string;
  readonly runs: readonly TextRun[];
  readonly markerGaps: ReadonlyMap<number, { readonly left: number; readonly right: number }>;
  readonly startGap: number;
  readonly endGap: number;
}

function isBoundary(value: unknown): value is BoundaryEmbed {
  return (
    value !== null &&
    typeof value === 'object' &&
    'grainBoundary' in value &&
    typeof (value as BoundaryEmbed).grainBoundary === 'string'
  );
}

function assertWellFormed(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RangeError(`${label} contains an unpaired high surrogate`);
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RangeError(`${label} contains an unpaired low surrogate`);
    }
  }
}

function assertBoundary(value: string, offset: number, label: string): void {
  if (
    offset > 0 &&
    offset < value.length &&
    value.charCodeAt(offset - 1) >= 0xd800 &&
    value.charCodeAt(offset - 1) <= 0xdbff &&
    value.charCodeAt(offset) >= 0xdc00 &&
    value.charCodeAt(offset) <= 0xdfff
  ) {
    throw new RangeError(`${label} splits a surrogate pair`);
  }
}

function indexSpan(span: Span, spanIndex: number, visibleFrom: number, tape: Y.Text): SpanIndex {
  const runs: TextRun[] = [];
  const textParts: string[] = [];
  const markerGaps = new Map<number, { left: number; right: number }>();
  let native = 0;
  let visible = 0;
  let inside = false;
  let startGap = -1;
  let endGap = -1;

  for (const part of tape.toDelta()) {
    const inserted = part.insert;
    if (typeof inserted === 'string') {
      if (inside) {
        runs.push({ from: visible, to: visible + inserted.length, nativeFrom: native });
        textParts.push(inserted);
        visible += inserted.length;
      }
      native += inserted.length;
      continue;
    }

    const boundary = isBoundary(inserted) ? inserted.grainBoundary : undefined;
    if (boundary === span.startBoundaryId) {
      inside = true;
      startGap = native + 1;
      markerGaps.set(visible, { left: startGap, right: startGap });
    } else if (boundary === span.endBoundaryId) {
      endGap = native;
      const gap = markerGaps.get(visible);
      markerGaps.set(
        visible,
        gap ? { left: gap.left, right: endGap } : { left: endGap, right: endGap },
      );
      inside = false;
    } else if (inside) {
      const gap = markerGaps.get(visible);
      markerGaps.set(
        visible,
        gap ? { left: gap.left, right: native + 1 } : { left: native, right: native + 1 },
      );
    }
    native++;
  }

  if (startGap < 0 || endGap < 0) {
    throw new Error(`span ${span.startBoundaryId}:${span.endBoundaryId} has missing markers`);
  }
  return {
    span,
    spanIndex,
    visibleFrom,
    visibleTo: visibleFrom + visible,
    text: textParts.join(''),
    runs,
    markerGaps,
    startGap,
    endGap,
  };
}

function visibleString(spans: readonly SpanIndex[]): string {
  return spans.map((span) => span.text).join('');
}

function chooseSpan(
  spans: readonly SpanIndex[],
  offset: number,
  affinity: TextAffinity,
  explicitSpanIndex?: number,
): SpanIndex {
  if (explicitSpanIndex !== undefined) {
    const explicit = spans[explicitSpanIndex];
    if (!explicit) throw new RangeError(`span index ${explicitSpanIndex} is out of range`);
    if (offset < explicit.visibleFrom || offset > explicit.visibleTo) {
      throw new RangeError('explicit span does not contain the insertion offset');
    }
    return explicit;
  }

  const interiors = spans.filter((span) => span.visibleFrom < offset && offset < span.visibleTo);
  if (interiors.length) return interiors[0]!;

  const touching = spans.filter((span) => span.visibleFrom <= offset && offset <= span.visibleTo);
  if (!touching.length) throw new RangeError('no insertion span contains the offset');
  return affinity === 'left' ? touching[0]! : touching.at(-1)!;
}

function insertionIndex(span: SpanIndex, localOffset: number, affinity: TextAffinity): number {
  if (localOffset < 0 || localOffset > span.text.length) {
    throw new RangeError('span insertion offset is out of bounds');
  }
  const markerGap = span.markerGaps.get(localOffset);
  if (markerGap) return affinity === 'left' ? markerGap.left : markerGap.right;
  for (const run of span.runs) {
    if (run.from < localOffset && localOffset < run.to) {
      return run.nativeFrom + localOffset - run.from;
    }
    if (localOffset === run.from) return run.nativeFrom;
    if (localOffset === run.to) return run.nativeFrom + run.to - run.from;
  }
  return localOffset === 0 ? span.startGap : span.endGap;
}

/**
 * Maps UTF-16 offsets in the concatenated visible text to native Y.Text indexes.
 * Native ranges include embeds; projected offsets do not. Deletion runs contain
 * strings only, so permanent boundary embeds are never deleted.
 */
export function mapTextEdit(
  spans: readonly Span[],
  tapes: ReadonlyMap<TapeId, Y.Text>,
  edit: TextEdit,
): MappedTextEdit {
  const indexed = spans.map((span, index) => {
    const tape = tapes.get(span.tapeId);
    if (!tape) throw new Error(`missing tape ${span.tapeId}`);
    const priorVisible = spans
      .slice(0, index)
      .reduce((total, prior) => total + (indexedLength(prior, tapes) ?? 0), 0);
    return indexSpan(span, index, priorVisible, tape);
  });
  const projectedText = visibleString(indexed);
  assertWellFormed(projectedText, 'projected text');
  assertWellFormed(edit.insert, 'inserted text');
  if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to)) {
    throw new RangeError('text range offsets must be integers');
  }
  if (edit.from < 0 || edit.to < edit.from || edit.to > projectedText.length) {
    throw new RangeError('text range is out of bounds');
  }
  assertBoundary(projectedText, edit.from, 'range start');
  assertBoundary(projectedText, edit.to, 'range end');

  const affinity = edit.affinity ?? (edit.from === projectedText.length ? 'left' : 'right');
  const insertionSpan = chooseSpan(indexed, edit.from, affinity, edit.spanIndex);
  const insertion = Object.freeze({
    tapeId: insertionSpan.span.tapeId,
    index: insertionIndex(insertionSpan, edit.from - insertionSpan.visibleFrom, affinity),
    spanIndex: insertionSpan.spanIndex,
    affinity,
  });

  const deletions: NativeTextRun[] = [];
  for (const span of indexed) {
    for (const run of span.runs) {
      const visibleFrom = span.visibleFrom + run.from;
      const visibleTo = span.visibleFrom + run.to;
      const overlapFrom = Math.max(edit.from, visibleFrom);
      const overlapTo = Math.min(edit.to, visibleTo);
      if (overlapFrom >= overlapTo) continue;
      deletions.push({
        tapeId: span.span.tapeId,
        from: run.nativeFrom + overlapFrom - visibleFrom,
        to: run.nativeFrom + overlapTo - visibleFrom,
      });
    }
  }
  deletions.sort((a, b) => a.tapeId.localeCompare(b.tapeId) || b.from - a.from);
  return Object.freeze({
    projectedText,
    deletions: Object.freeze(deletions.map((run) => Object.freeze(run))),
    insertion,
  });
}

function indexedLength(span: Span, tapes: ReadonlyMap<TapeId, Y.Text>): number | undefined {
  const tape = tapes.get(span.tapeId);
  if (!tape) return undefined;
  let inside = false;
  let length = 0;
  for (const part of tape.toDelta()) {
    if (typeof part.insert === 'string') {
      if (inside) length += part.insert.length;
    } else if (isBoundary(part.insert)) {
      if (part.insert.grainBoundary === span.startBoundaryId) inside = true;
      else if (part.insert.grainBoundary === span.endBoundaryId) break;
    }
  }
  return length;
}
