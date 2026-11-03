import type { Span, TapeId } from '../types.js';
import type { NodeId, TextAffinity } from '../../semantic/types.js';
import { splitsSurrogatePair } from '../../semantic/types.js';
import { INLINE_KINDS } from '../schema.js';
import type { InlineFragment, Transfer } from '../../semantic/draft.js';
import type {
  DraftFragment,
  DraftNodeState,
  DraftPiece,
  DraftSpan,
  InsertionSlotTarget,
  InsertedPiece,
  PlanBoundary,
} from './types.js';
import { DraftTextBuffers } from './buffers.js';

export interface NativeInsertion {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly spanIndex: number;
  readonly affinity: TextAffinity;
}

export interface DraftFragmentHost {
  allNodes(): Iterable<DraftNodeState>;
  requireNode(id: NodeId): DraftNodeState;
  ensureVisibleOrCreated(node: DraftNodeState): void;
  readText(node: DraftNodeState): void;
  baseSpans(id: NodeId): readonly Span[];
  sourceText(span: Span): string;
  mapInsertion(spans: readonly Span[], offset: number, affinity: TextAffinity): NativeInsertion;
  allocateId(role: string): string;
}

const fragmentIds = new WeakMap<object, string>();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inlineContent(node: DraftNodeState): string {
  return node.spans.flatMap((span) => span.pieces.map((piece) => piece.text)).join('');
}

function slicePiece(piece: DraftPiece, from: number, to: number): DraftPiece | undefined {
  if (from >= to) return undefined;
  if (piece.kind === 'existing') {
    return {
      ...piece,
      from: piece.from + from,
      to: piece.from + to,
      text: piece.text.slice(from, to),
    };
  }
  return {
    ...piece,
    from: piece.from + from,
    to: piece.from + to,
    text: piece.text.slice(from, to),
  };
}

function slicePieces(pieces: readonly DraftPiece[], from: number, to: number): DraftPiece[] {
  const result: DraftPiece[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const next = cursor + piece.text.length;
    const left = Math.max(from, cursor);
    const right = Math.min(to, next);
    if (left < right) {
      const selected = slicePiece(piece, left - cursor, right - cursor);
      if (selected) result.push(selected);
    }
    cursor = next;
  }
  return result;
}

/** Owns transfer fragments, insertion slots, and text-span edits for one semantic draft. */
export class DraftFragments {
  private readonly buffers: DraftTextBuffers;
  private readonly transferBoundaries: PlanBoundary[] = [];
  private readonly transferBoundarySlots = new Map<string, InsertionSlotTarget>();
  private readonly fragments = new Map<string, DraftFragment>();
  private readonly consumedFragments = new Set<string>();

  constructor(private readonly host: DraftFragmentHost) {
    this.buffers = new DraftTextBuffers(() => host.allocateId('buffer'));
  }

  createInsertedPiece(anchor: InsertionSlotTarget, text: string): InsertedPiece {
    return this.buffers.create(anchor, text);
  }

  cutInline(id: NodeId, from: number, to: number): InlineFragment {
    const fragmentId = this.host.allocateId('fragment');
    this.cutFragmentInternal(id, from, to, fragmentId);
    return this.handleFor(fragmentId);
  }

  handleFor(fragmentId: string): InlineFragment {
    const fragment = this.fragments.get(fragmentId);
    assert(fragment, 'cut did not create a fragment');
    const handle = Object.freeze({ text: fragment.text }) as InlineFragment;
    fragmentIds.set(handle, fragmentId);
    return handle;
  }

  fragmentIdFor(fragment: InlineFragment): string {
    const fragmentId = fragmentIds.get(fragment);
    assert(fragmentId, 'fragment was not created by this draft');
    assert(this.fragments.has(fragmentId), 'fragment does not belong to this draft');
    assert(!this.consumedFragments.has(fragmentId), 'fragment has already been inserted');
    return fragmentId;
  }

  insertFragment(
    destination: NodeId,
    at: number,
    affinity: TextAffinity,
    fragment: InlineFragment,
  ): void {
    const fragmentId = this.fragmentIdFor(fragment);
    this.insertFragmentInternal(destination, at, affinity, fragmentId);
  }

  applyCut(id: NodeId, from: number, to: number, fragmentId: string): void {
    this.cutFragmentInternal(id, from, to, fragmentId);
  }

  applyInsert(destination: NodeId, at: number, affinity: TextAffinity, fragmentId: string): void {
    this.insertFragmentInternal(destination, at, affinity, fragmentId);
  }

  transferInlineRange(transfer: Transfer): void {
    this.transferInternal(transfer);
  }

  assertAllConsumed(): void {
    assert(
      [...this.fragments.keys()].every((id) => this.consumedFragments.has(id)),
      'every cut fragment must be inserted before the action is compiled',
    );
  }

  assertPieceSources(): void {
    for (const node of this.host.allNodes()) {
      for (const span of node.spans) {
        for (const piece of span.pieces) this.assertPieceSource(piece);
      }
    }
  }

  get boundaryPlans(): readonly PlanBoundary[] {
    return this.transferBoundaries;
  }

  textBufferSnapshot(): ReadonlyMap<string, import('./types.js').DraftTextBuffer> {
    return this.buffers.snapshot();
  }

  private assertPieceSource(piece: DraftPiece): void {
    if (piece.kind === 'inserted') {
      this.buffers.assertPiece(piece);
      return;
    }
    const sourceSpan = this.host.baseSpans(piece.source)[piece.sourceSpanIndex];
    assert(sourceSpan, `missing source span ${piece.sourceSpanIndex} on ${piece.source}`);
    assert(sourceSpan.tapeId === piece.tapeId, `source tape changed for ${piece.source}`);
    const sourceText = this.host.sourceText(sourceSpan);
    assert(
      Number.isInteger(piece.from) &&
        Number.isInteger(piece.to) &&
        piece.from >= 0 &&
        piece.to >= piece.from &&
        piece.to <= sourceText.length,
      `existing text slice is outside ${piece.source}`,
    );
    assert(
      piece.text === sourceText.slice(piece.from, piece.to),
      `existing text slice diverged from ${piece.source}`,
    );
  }

  insertionTarget(
    node: DraftNodeState,
    offset: number,
    affinity: TextAffinity,
  ): { spanIndex: number; localOffset: number; anchor: InsertionSlotTarget } {
    let global = 0;
    const spans = node.spans.map((span, index) => {
      const length = span.pieces.reduce((total, piece) => total + piece.text.length, 0);
      const result = { span, index, start: global, end: global + length, length };
      global += length;
      return result;
    });
    const touching = spans.filter((span) => span.start <= offset && offset <= span.end);
    assert(touching.length > 0, 'no insertion span contains the offset');
    const target = affinity === 'left' ? touching[0]! : touching.at(-1)!;
    const localOffset = offset - target.start;
    if (!target.span.pieces.length) {
      const insertionSlot = target.span.insertionSlot;
      if (insertionSlot) {
        return {
          spanIndex: target.index,
          localOffset,
          anchor: { ...insertionSlot, affinity },
        };
      }
      if (target.span.created) {
        return {
          spanIndex: target.index,
          localOffset,
          anchor: {
            tapeId: target.span.span.tapeId,
            index: 1,
            spanIndex: target.index,
            affinity,
          },
        };
      }
    }

    let pieceStart = 0;
    let chosen: { piece: DraftPiece; local: number } | undefined;
    for (const piece of target.span.pieces) {
      const end = pieceStart + piece.text.length;
      if (pieceStart < localOffset && localOffset < end) {
        chosen = { piece, local: localOffset - pieceStart };
        break;
      }
      if (localOffset === pieceStart && affinity === 'right') {
        chosen = { piece, local: 0 };
        break;
      }
      if (localOffset === end && affinity === 'left') chosen = { piece, local: piece.text.length };
      pieceStart = end;
    }
    if (!chosen) {
      const candidate = affinity === 'left' ? target.span.pieces.at(-1) : target.span.pieces[0];
      if (candidate) {
        chosen = {
          piece: candidate,
          local: affinity === 'left' ? candidate.text.length : 0,
        };
      }
    }
    if (chosen?.piece.kind === 'inserted') {
      return {
        spanIndex: target.index,
        localOffset,
        anchor: {
          ...chosen.piece.anchor,
          affinity,
          parentBufferId: chosen.piece.bufferId,
          parentBufferOffset: chosen.piece.from + chosen.local,
        },
      };
    }
    const source = chosen?.piece;
    if (source?.kind === 'existing') {
      const sourceSpan = this.host.baseSpans(source.source)[source.sourceSpanIndex];
      assert(sourceSpan, 'existing source span is missing');
      const sourceOffset = source.from + chosen!.local;
      const anchor = this.host.mapInsertion([sourceSpan], sourceOffset, affinity);
      return { spanIndex: target.index, localOffset, anchor };
    }
    const anchor = this.host.mapInsertion([target.span.span], localOffset, affinity);
    return { spanIndex: target.index, localOffset, anchor };
  }

  private transferInternal(transfer: Transfer): void {
    const source = this.host.requireNode(transfer.source);
    const destination = this.host.requireNode(transfer.destination);
    this.host.ensureVisibleOrCreated(source);
    this.host.ensureVisibleOrCreated(destination);
    assert(
      INLINE_KINDS.has(source.type) && INLINE_KINDS.has(destination.type),
      'transfers require inline nodes',
    );
    this.host.readText(source);
    if (source.id === destination.id) {
      this.reorderInlineRange(source, transfer);
      return;
    }
    this.host.readText(destination);
    const destinationContent = inlineContent(destination);
    assert(
      Number.isInteger(transfer.at) && transfer.at >= 0 && transfer.at <= destinationContent.length,
      'transfer destination is out of bounds',
    );
    assert(
      !splitsSurrogatePair(destinationContent, transfer.at),
      'transfer destination splits a surrogate pair',
    );
    const fragmentId = this.host.allocateId('fragment');
    this.cutFragmentInternal(source.id, transfer.from, transfer.to, fragmentId);
    this.insertFragmentInternal(destination.id, transfer.at, transfer.affinity, fragmentId);
  }

  private cutFragmentInternal(id: NodeId, from: number, to: number, fragmentId: string): void {
    assert(!this.fragments.has(fragmentId), `fragment ${fragmentId} already exists`);
    const node = this.host.requireNode(id);
    this.host.ensureVisibleOrCreated(node);
    assert(INLINE_KINDS.has(node.type), `${node.type} nodes do not have inline text`);
    this.host.readText(node);
    const content = inlineContent(node);
    assert(Number.isInteger(from) && Number.isInteger(to), 'cut offsets must be integers');
    assert(from >= 0 && to > from && to <= content.length, 'cut range is out of bounds');
    assert(
      !splitsSurrogatePair(content, from) && !splitsSurrogatePair(content, to),
      'cut range splits a surrogate pair',
    );
    const cut = this.cutSourceRange(node, from, to);
    node.spans = cut.remaining;
    this.fragments.set(fragmentId, {
      spans: cut.moved,
      text: cut.moved.flatMap((span) => span.pieces.map((piece) => piece.text)).join(''),
    });
  }

  private insertFragmentInternal(
    destinationId: NodeId,
    at: number,
    affinity: TextAffinity,
    fragmentId: string,
  ): void {
    const fragment = this.fragments.get(fragmentId);
    assert(fragment, `unknown fragment ${fragmentId}`);
    assert(!this.consumedFragments.has(fragmentId), `fragment ${fragmentId} was already used`);
    const destination = this.host.requireNode(destinationId);
    this.host.ensureVisibleOrCreated(destination);
    assert(INLINE_KINDS.has(destination.type), 'fragments require an inline destination');
    this.host.readText(destination);
    const content = inlineContent(destination);
    assert(
      Number.isInteger(at) && at >= 0 && at <= content.length,
      'fragment target is out of bounds',
    );
    assert(!splitsSurrogatePair(content, at), 'fragment target splits a surrogate pair');
    destination.spans = this.insertTransferAt(destination, at, affinity, fragment.spans);
    this.consumedFragments.add(fragmentId);
  }

  private cutSourceRange(
    node: DraftNodeState,
    from: number,
    to: number,
  ): { remaining: DraftSpan[]; moved: DraftSpan[] } {
    const remaining: DraftSpan[] = [];
    const moved: DraftSpan[] = [];
    let global = 0;
    for (let index = 0; index < node.spans.length; index++) {
      const current = node.spans[index]!;
      const text = current.pieces.map((piece) => piece.text).join('');
      const spanStart = global;
      const spanEnd = global + text.length;
      global = spanEnd;
      const localFrom = Math.max(0, from - spanStart);
      const localTo = Math.min(text.length, to - spanStart);
      if (localFrom >= localTo) {
        remaining.push(current);
        continue;
      }
      const span = current.span;
      const fullSpan = localFrom === 0 && localTo === text.length;
      if (
        fullSpan &&
        node.spans.length > 1 &&
        current.pieces.every((piece) => piece.kind === 'inserted')
      ) {
        moved.push(current);
        continue;
      }
      const startBoundary =
        localFrom === 0 && !fullSpan
          ? span.startBoundaryId
          : this.cutBoundary(node, current, localFrom, 'start');
      const endBoundary =
        localTo === text.length && !fullSpan
          ? span.endBoundaryId
          : this.cutBoundary(node, current, localTo, 'end');
      if (localFrom > 0 || fullSpan) {
        const left = { ...span, endBoundaryId: startBoundary };
        const insertionSlot =
          this.transferBoundarySlots.get(startBoundary) ?? current.insertionSlot;
        remaining.push({
          span: left,
          sourceSpanIndex: current.sourceSpanIndex,
          pieces: slicePieces(current.pieces, 0, localFrom),
          created: current.created,
          ...(insertionSlot ? { insertionSlot } : {}),
        });
      }
      const insertionSlot = this.transferBoundarySlots.get(startBoundary) ?? current.insertionSlot;
      moved.push({
        span: { ...span, startBoundaryId: startBoundary, endBoundaryId: endBoundary },
        sourceSpanIndex: current.sourceSpanIndex,
        pieces: slicePieces(current.pieces, localFrom, localTo),
        created: current.created,
        ...(insertionSlot ? { insertionSlot } : {}),
      });
      if (localTo < text.length || fullSpan) {
        const right = { ...span, startBoundaryId: endBoundary };
        const rightInsertionSlot =
          this.transferBoundarySlots.get(endBoundary) ?? current.insertionSlot;
        remaining.push({
          span: right,
          sourceSpanIndex: current.sourceSpanIndex,
          pieces: slicePieces(current.pieces, localTo, text.length),
          created: current.created,
          ...(rightInsertionSlot ? { insertionSlot: rightInsertionSlot } : {}),
        });
      }
    }
    assert(moved.length > 0, 'cut range has no source span');
    return { remaining, moved };
  }

  private reorderInlineRange(node: DraftNodeState, transfer: Transfer): void {
    const content = inlineContent(node);
    assert(
      Number.isInteger(transfer.from) &&
        Number.isInteger(transfer.to) &&
        transfer.from >= 0 &&
        transfer.to > transfer.from &&
        transfer.to <= content.length,
      'transfer range is out of bounds',
    );
    assert(
      !splitsSurrogatePair(content, transfer.from) && !splitsSurrogatePair(content, transfer.to),
      'transfer splits a surrogate pair',
    );
    assert(
      Number.isInteger(transfer.at) && transfer.at >= 0 && transfer.at <= content.length,
      'transfer destination is out of bounds',
    );
    assert(
      !splitsSurrogatePair(content, transfer.at),
      'transfer destination splits a surrogate pair',
    );
    if (transfer.at === transfer.from || transfer.at === transfer.to) return;
    assert(
      !(transfer.from < transfer.at && transfer.at < transfer.to),
      'same-node destination cannot be inside the transferred range',
    );

    const segments: { readonly draft: DraftSpan; readonly from: number; readonly to: number }[] =
      [];
    let globalStart = 0;
    for (let spanIndex = 0; spanIndex < node.spans.length; spanIndex++) {
      const current = node.spans[spanIndex]!;
      const spanContent = current.pieces.map((piece) => piece.text).join('');
      const localCuts = [transfer.from, transfer.to, transfer.at]
        .map((cut) => cut - globalStart)
        .filter((cut) => cut > 0 && cut < spanContent.length)
        .sort((a, b) => a - b);
      const boundaries = new Map<number, string>([
        [0, current.span.startBoundaryId],
        [spanContent.length, current.span.endBoundaryId],
      ]);
      for (const local of localCuts) {
        const absolute = globalStart + local;
        const affinity =
          absolute === transfer.at
            ? transfer.affinity
            : absolute === transfer.from
              ? 'right'
              : 'left';
        boundaries.set(
          local,
          this.cutBoundary(
            node,
            current,
            local,
            absolute === transfer.to ? 'end' : 'start',
            affinity,
          ),
        );
      }
      const positions = [...new Set([0, ...localCuts, spanContent.length])].sort((a, b) => a - b);
      for (let index = 0; index < positions.length - 1; index++) {
        const from = positions[index]!;
        const to = positions[index + 1]!;
        const insertionSlot =
          this.transferBoundarySlots.get(boundaries.get(from)!) ?? current.insertionSlot;
        segments.push({
          draft: {
            span: {
              ...current.span,
              startBoundaryId: boundaries.get(from)!,
              endBoundaryId: boundaries.get(to)!,
            },
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, from, to),
            created: current.created,
            ...(insertionSlot ? { insertionSlot } : {}),
          },
          from: globalStart + from,
          to: globalStart + to,
        });
      }
      globalStart += spanContent.length;
    }

    const moved = segments.filter(
      (segment) =>
        segment.to > segment.from && segment.from >= transfer.from && segment.to <= transfer.to,
    );
    assert(moved.length > 0, 'transfer range has no source span');
    const movedSet = new Set(moved);
    const remaining = segments.filter((segment) => !movedSet.has(segment));
    const adjustedAt =
      transfer.at < transfer.from ? transfer.at : transfer.at - (transfer.to - transfer.from);
    let accumulated = 0;
    let insertionIndex = remaining.length;
    for (let index = 0; index < remaining.length; index++) {
      const segment = remaining[index]!;
      const length = segment.to - segment.from;
      if (adjustedAt < accumulated + length) {
        insertionIndex = index;
        break;
      }
      accumulated += length;
      if (adjustedAt === accumulated) {
        insertionIndex = index + 1;
        break;
      }
    }
    node.spans = [
      ...remaining.slice(0, insertionIndex).map((segment) => segment.draft),
      ...moved.map((segment) => segment.draft),
      ...remaining.slice(insertionIndex).map((segment) => segment.draft),
    ];
  }

  private cutBoundary(
    node: DraftNodeState,
    current: DraftSpan,
    offset: number,
    role: 'start' | 'end',
    affinity?: TextAffinity,
  ): string {
    const content = current.pieces.map((piece) => piece.text).join('');
    assert(offset >= 0 && offset <= content.length, 'transfer boundary is outside its source span');
    const resolvedAffinity = affinity ?? (role === 'start' ? 'right' : 'left');
    let cursor = 0;
    let chosen: { piece: DraftPiece; local: number } | undefined;
    for (const piece of current.pieces) {
      const end = cursor + piece.text.length;
      if (cursor < offset && offset < end) {
        chosen = { piece, local: offset - cursor };
        break;
      }
      if (offset === cursor && resolvedAffinity === 'right') {
        chosen = { piece, local: 0 };
        break;
      }
      if (offset === end && resolvedAffinity === 'left') {
        chosen = { piece, local: piece.text.length };
      }
      cursor = end;
    }

    let mapped: NativeInsertion;
    if (chosen?.piece.kind === 'inserted') {
      mapped = {
        tapeId: chosen.piece.anchor.tapeId,
        index: chosen.piece.anchor.index,
        spanIndex: chosen.piece.anchor.spanIndex,
        affinity: resolvedAffinity,
      };
    } else if (chosen?.piece.kind === 'existing') {
      const sourceSpan = this.host.baseSpans(chosen.piece.source)[chosen.piece.sourceSpanIndex];
      assert(sourceSpan, 'existing transfer source span is missing');
      mapped = this.host.mapInsertion(
        [sourceSpan],
        chosen.piece.from + chosen.local,
        resolvedAffinity,
      );
    } else {
      mapped = this.host.mapInsertion([current.span], offset, resolvedAffinity);
    }
    let insertionOffset = 0;
    let foundBoundaryPiece = false;
    for (const span of node.spans) {
      for (const piece of span.pieces) {
        if (chosen && span === current && piece === chosen.piece) {
          if (piece.kind === 'inserted') insertionOffset += chosen.local;
          foundBoundaryPiece = true;
          break;
        }
        if (
          piece.kind === 'inserted' &&
          piece.anchor.tapeId === mapped.tapeId &&
          piece.anchor.index === mapped.index
        ) {
          insertionOffset += piece.text.length;
        }
      }
      if (foundBoundaryPiece) break;
    }
    const boundaryId = this.host.allocateId('boundary');
    const insertionSlot: InsertionSlotTarget = {
      tapeId: mapped.tapeId,
      index: mapped.index,
      spanIndex: mapped.spanIndex,
      affinity: resolvedAffinity,
      ...(chosen?.piece.kind === 'inserted'
        ? {
            parentBufferId: chosen.piece.bufferId,
            parentBufferOffset: chosen.piece.from + chosen.local,
          }
        : {}),
    };
    this.transferBoundarySlots.set(boundaryId, insertionSlot);
    this.transferBoundaries.push({
      tapeId: mapped.tapeId,
      index: mapped.index,
      boundaryId,
      insertionOffset,
      side: role,
      order: this.transferBoundaries.length,
      ...(chosen?.piece.kind === 'inserted'
        ? {
            sourceBufferId: chosen.piece.bufferId,
            sourceBufferOffset: chosen.piece.from + chosen.local,
          }
        : {}),
    });
    return boundaryId;
  }

  private insertTransferAt(
    node: DraftNodeState,
    offset: number,
    affinity: TextAffinity,
    moved: readonly DraftSpan[],
  ): DraftSpan[] {
    let global = 0;
    const location = node.spans.map((span, index) => {
      const length = span.pieces.reduce((total, piece) => total + piece.text.length, 0);
      const value = { span, index, start: global, end: global + length, length };
      global += length;
      return value;
    });
    const touching = location.filter((span) => span.start <= offset && offset <= span.end);
    assert(touching.length > 0, 'transfer destination has no insertion span');
    const target = affinity === 'left' ? touching[0]! : touching.at(-1)!;
    const local = offset - target.start;
    const result: DraftSpan[] = [];
    for (let index = 0; index < node.spans.length; index++) {
      if (index !== target.index) {
        result.push(node.spans[index]!);
        continue;
      }
      const current = target.span;
      const content = current.pieces.map((piece) => piece.text).join('');
      if (local === 0 && (content.length > 0 || affinity === 'right')) {
        result.push(...moved, current);
      } else if (local === content.length && (content.length > 0 || affinity === 'left')) {
        result.push(current, ...moved);
      } else {
        const cutId = this.cutBoundary(node, current, local, affinity === 'left' ? 'end' : 'start');
        const leftSpan = { ...current.span, endBoundaryId: cutId };
        const rightSpan = { ...current.span, startBoundaryId: cutId };
        const insertionSlot = this.transferBoundarySlots.get(cutId) ?? current.insertionSlot;
        result.push(
          {
            span: leftSpan,
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, 0, local),
            created: current.created,
            ...(insertionSlot ? { insertionSlot } : {}),
          },
          ...moved,
          {
            span: rightSpan,
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, local, content.length),
            created: current.created,
            ...(insertionSlot ? { insertionSlot } : {}),
          },
        );
      }
    }
    return result;
  }

  dropUnusedCreatedInsertionSpans(newTapeSpans: ReadonlyMap<NodeId, Span>): void {
    for (const node of this.host.allNodes()) {
      if (!node.created || !INLINE_KINDS.has(node.type)) continue;
      const created = newTapeSpans.get(node.id);
      if (!created) continue;
      const hasOtherFinalSpan = node.spans.some((span) => span.span.tapeId !== created.tapeId);
      if (!hasOtherFinalSpan) continue;

      let hasFinalOwnerOutsideNode = false;
      let hasActionTextOnTape = false;
      for (const owner of this.host.allNodes()) {
        for (const span of owner.spans) {
          if (span.span.tapeId === created.tapeId && owner.id !== node.id) {
            hasFinalOwnerOutsideNode = true;
          }
          for (const piece of span.pieces) {
            if (piece.kind !== 'inserted' || !piece.text) continue;
            const buffer = this.buffers.get(piece.bufferId);
            if (buffer?.anchor.tapeId === created.tapeId) hasActionTextOnTape = true;
          }
        }
      }
      if (hasFinalOwnerOutsideNode || hasActionTextOnTape) continue;
      node.spans = node.spans.filter(
        (span) => span.span.tapeId !== created.tapeId || !span.created,
      );
    }
  }
}
