import * as Y from 'yjs';

import type { BoundaryEmbed, Span, TapeId } from './canonical-model.js';
import type { CanonicalTextEdit } from './canonical/action-types.js';
import type { TextAffinity } from './semantic/types.js';
export type { TextAffinity, TextEdit } from './semantic/types.js';
export type { CanonicalTextEdit } from './canonical/action-types.js';

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

export interface ProjectedSpanIndex {
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

export interface NativeTapePart {
  readonly insert: unknown;
  readonly nativeFrom: number;
  readonly nativeTo: number;
}

export interface NativeBoundaryItem {
  readonly boundaryId: string;
  readonly itemId: string;
  readonly index: number;
}

interface NativeItem {
  readonly id: { readonly client: number; readonly clock: number };
  readonly right: NativeItem | null;
  readonly deleted: boolean;
  readonly length: number;
  readonly content: unknown;
}

interface NativeText {
  readonly _start: NativeItem | null;
}

/** A reconstructible index over one tape revision. Build it once per revision. */
export interface NativeTapeIndex {
  readonly tapeId: TapeId;
  readonly parts: readonly NativeTapePart[];
  readonly partStarts: readonly number[];
  readonly boundaries: ReadonlyMap<string, number>;
  readonly boundaryItems: readonly NativeBoundaryItem[];
  readonly hasFormatting: boolean;
  readonly length: number;
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

export function indexNativeTape(tapeId: TapeId, tape: Y.Text): NativeTapeIndex {
  const parts: NativeTapePart[] = [];
  const boundaries = new Map<string, number>();
  const boundaryItems: NativeBoundaryItem[] = [];
  let native = 0;
  let hasFormatting = false;
  let item = (tape as unknown as NativeText)._start;
  while (item) {
    if (!item.deleted) {
      const content =
        item.content && typeof item.content === 'object'
          ? (item.content as {
              readonly str?: unknown;
              readonly embed?: unknown;
              readonly key?: unknown;
            })
          : {};
      if ('key' in content) {
        hasFormatting = true;
        item = item.right;
        continue;
      }
      const insert =
        typeof content.str === 'string'
          ? content.str
          : 'embed' in content
            ? content.embed
            : Object.freeze({ grainUnsupported: true });
      const nativeTo = native + item.length;
      parts.push(Object.freeze({ insert, nativeFrom: native, nativeTo }));
      const boundary = isBoundary(insert) ? insert.grainBoundary : undefined;
      if (boundary !== undefined) {
        boundaries.set(boundary, native);
        boundaryItems.push(
          Object.freeze({
            boundaryId: boundary,
            itemId: `${item.id.client}:${item.id.clock}`,
            index: native,
          }),
        );
      }
      native = nativeTo;
    }
    item = item.right;
  }
  return Object.freeze({
    tapeId,
    parts: Object.freeze(parts),
    partStarts: Object.freeze(parts.map((part) => part.nativeFrom)),
    boundaries,
    boundaryItems: Object.freeze(boundaryItems),
    hasFormatting,
    length: native,
  });
}

function indexSpan(
  span: Span,
  spanIndex: number,
  visibleFrom: number,
  tape: NativeTapeIndex,
): ProjectedSpanIndex {
  const runs: TextRun[] = [];
  const textParts: string[] = [];
  const markerGaps = new Map<number, { left: number; right: number }>();
  let visible = 0;
  const start = tape.boundaries.get(span.startBoundaryId);
  const end = tape.boundaries.get(span.endBoundaryId);
  if (start === undefined || end === undefined || start >= end) {
    throw new Error(`span ${span.startBoundaryId}:${span.endBoundaryId} has missing markers`);
  }

  const startGap = start + 1;
  const endGap = end;
  let low = 0;
  let high = tape.partStarts.length;
  const firstNative = start + 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tape.partStarts[middle]! < firstNative) low = middle + 1;
    else high = middle;
  }
  for (let partIndex = low; partIndex < tape.parts.length; partIndex++) {
    const part = tape.parts[partIndex]!;
    if (part.nativeFrom > end) break;
    const inserted = part.insert;
    if (typeof inserted === 'string') {
      runs.push({ from: visible, to: visible + inserted.length, nativeFrom: part.nativeFrom });
      textParts.push(inserted);
      visible += inserted.length;
      continue;
    }

    const boundary = isBoundary(inserted) ? inserted.grainBoundary : undefined;
    if (boundary === span.endBoundaryId) {
      const gap = markerGaps.get(visible);
      markerGaps.set(
        visible,
        gap ? { left: gap.left, right: endGap } : { left: endGap, right: endGap },
      );
    } else {
      const gap = markerGaps.get(visible);
      markerGaps.set(
        visible,
        gap
          ? { left: gap.left, right: part.nativeTo }
          : { left: part.nativeFrom, right: part.nativeTo },
      );
    }
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

function visibleString(spans: readonly ProjectedSpanIndex[]): string {
  return spans.map((span) => span.text).join('');
}

function chooseSpan(
  spans: readonly ProjectedSpanIndex[],
  offset: number,
  affinity: TextAffinity,
  explicitSpanIndex?: number,
): ProjectedSpanIndex {
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

function insertionIndex(
  span: ProjectedSpanIndex,
  localOffset: number,
  affinity: TextAffinity,
): number {
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
  edit: CanonicalTextEdit,
): MappedTextEdit {
  const indexedTapes = new Map<TapeId, NativeTapeIndex>();
  for (const span of spans) {
    if (indexedTapes.has(span.tapeId)) continue;
    const tape = tapes.get(span.tapeId);
    if (!tape) throw new Error(`missing tape ${span.tapeId}`);
    indexedTapes.set(span.tapeId, indexNativeTape(span.tapeId, tape));
  }
  return mapTextEditIndexed(spans, indexedTapes, edit);
}

export function mapTextEditIndexed(
  spans: readonly Span[],
  tapes: ReadonlyMap<TapeId, NativeTapeIndex>,
  edit: CanonicalTextEdit,
): MappedTextEdit {
  return mapProjectedTextEdit(indexProjectedSpans(spans, tapes), edit);
}

export interface ProjectedTextIndex {
  readonly spans: readonly ProjectedSpanIndex[];
  readonly text: string;
}

export function indexProjectedSpans(
  spans: readonly Span[],
  tapes: ReadonlyMap<TapeId, NativeTapeIndex>,
): ProjectedTextIndex {
  let visibleFrom = 0;
  const indexed = spans.map((span, index) => {
    const tape = tapes.get(span.tapeId);
    if (!tape) throw new Error(`missing tape index ${span.tapeId}`);
    const result = indexSpan(span, index, visibleFrom, tape);
    visibleFrom = result.visibleTo;
    return result;
  });
  const projectedText = visibleString(indexed);
  return Object.freeze({ spans: Object.freeze(indexed), text: projectedText });
}

export function mapProjectedTextEdit(
  projected: ProjectedTextIndex,
  edit: CanonicalTextEdit,
): MappedTextEdit {
  const indexed = projected.spans;
  const projectedText = projected.text;
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

export function spanTextFromIndex(span: Span, index: NativeTapeIndex): string {
  return indexSpan(span, 0, 0, index).text;
}
