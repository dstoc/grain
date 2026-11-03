import { isInlineNode, type InlineNode, type MarkdownNode } from './node.js';
import type { ParserConversionPlan } from './block-parser/types.js';
import type { Bookmark } from './canonical/action-types.js';
import type { DraftNode, DraftTextPiece, ParserTreeDraft, TreeDraft } from './semantic/draft.js';
import type { CreateNodeSpec as NodeSpec, NodeId } from './semantic/types.js';

interface TextEvent {
  readonly from: number;
  readonly to: number;
  readonly targetId: NodeId;
  readonly at: number;
}

type ComposedPiece =
  | { readonly kind: 'retain'; readonly from: number; readonly to: number }
  | { readonly kind: 'inserted'; readonly from: number; readonly to: number; readonly text: string }
  | { readonly kind: 'synthesize'; readonly text: string };

interface SyntheticInsertion {
  readonly at: number;
  readonly text: string;
  readonly order: number;
}

function nodeKey(path: readonly number[]): string {
  return path.join('.') || 'root';
}

function parsedChildren(node: MarkdownNode): readonly MarkdownNode[] {
  return node.children ?? [];
}

function findLocation(
  draft: TreeDraft,
  rootId: NodeId,
  targetId: NodeId,
): { readonly parentId: NodeId; readonly before: NodeId | null } | undefined {
  const visit = (parent: DraftNode): { parentId: NodeId; before: NodeId | null } | undefined => {
    const index = parent.children.indexOf(targetId);
    if (index >= 0) return { parentId: parent.id, before: parent.children[index + 1] ?? null };
    for (const childId of parent.children) {
      const result = visit(draft.node(childId));
      if (result) return result;
    }
    return undefined;
  };
  return visit(draft.node(rootId));
}

function sourceTextForPiece(source: string, piece: ComposedPiece): string {
  return piece.kind === 'synthesize' ? piece.text : source.slice(piece.from, piece.to);
}

function composedText(source: string, pieces: readonly ComposedPiece[]): string {
  return pieces.map((piece) => sourceTextForPiece(source, piece)).join('');
}

function validateDraftSourcePieces(source: string, pieces: readonly DraftTextPiece[]): void {
  let cursor = 0;
  for (const piece of pieces) {
    if (piece.from !== cursor || piece.to <= piece.from || piece.to > source.length) {
      throw new Error('draft source pieces do not cover the current inline text');
    }
    cursor = piece.to;
  }
  if (cursor !== source.length && source.length !== 0) {
    throw new Error('draft source pieces do not cover the current inline text');
  }
}

function composePieces(
  source: string,
  parserPieces: ParserConversionPlan['inlinePieces'][string],
  sourcePieces: readonly DraftTextPiece[],
): readonly ComposedPiece[] {
  const result: ComposedPiece[] = [];
  for (const piece of parserPieces) {
    if (piece.kind === 'synthesize') {
      result.push({ kind: 'synthesize', text: piece.text });
      continue;
    }
    let cursor = piece.sourceFrom;
    for (const sourcePiece of sourcePieces) {
      const from = Math.max(piece.sourceFrom, sourcePiece.from);
      const to = Math.min(piece.sourceTo, sourcePiece.to);
      if (from >= to) continue;
      if (from !== cursor) throw new Error('parser range crosses an unmapped draft source gap');
      result.push(
        sourcePiece.kind === 'inserted'
          ? { kind: 'inserted', from, to, text: source.slice(from, to) }
          : { kind: 'retain', from, to },
      );
      cursor = to;
    }
    if (cursor !== piece.sourceTo) {
      throw new Error('parser range is not fully mapped to draft source pieces');
    }
  }
  return Object.freeze(result);
}

function seedContent(pieces: readonly ComposedPiece[]): string {
  return pieces
    .filter(
      (piece): piece is Extract<ComposedPiece, { kind: 'inserted' | 'synthesize' }> =>
        piece.kind === 'inserted' || piece.kind === 'synthesize',
    )
    .map((piece) => piece.text)
    .join('');
}

function sourceBoundaryBefore(pieces: readonly ComposedPiece[], index: number): number {
  for (let next = index + 1; next < pieces.length; next++) {
    const piece = pieces[next]!;
    if (piece.kind !== 'synthesize') return piece.from;
  }
  for (let previous = index - 1; previous >= 0; previous--) {
    const piece = pieces[previous]!;
    if (piece.kind !== 'synthesize') return piece.to;
  }
  return 0;
}

function specFor(node: MarkdownNode, content = ''): NodeSpec {
  switch (node.type) {
    case 'document':
      throw new Error('a semantic draft cannot create another root');
    case 'paragraph':
      return { type: 'paragraph', content };
    case 'section':
      return { type: 'section', content, marker: node.marker };
    case 'code-block':
      return { type: 'code-block', content, info: node.info };
    case 'list':
      return { type: 'list' };
    case 'list-item':
      return { type: 'list-item', marker: node.marker, checked: node.checked ?? null };
    case 'block-quote':
      return { type: 'block-quote', marker: node.marker };
  }
}

function validateTextPieces(
  source: string,
  plan: ParserConversionPlan,
): { readonly firstInlineKey: string } | undefined {
  const inline = new Map<string, InlineNode>();
  const visit = (node: MarkdownNode, path: number[]) => {
    if (isInlineNode(node)) inline.set(nodeKey(path), node);
    for (const [index, child] of parsedChildren(node).entries()) visit(child, [...path, index]);
  };
  visit(plan.output, []);
  const firstInlineKey = inline.keys().next().value as string | undefined;
  if (!firstInlineKey) return;
  if (inline.size === 1) {
    const [key, node] = inline.entries().next().value!;
    if (key === '0' && node.type === 'paragraph') return;
  }

  const retainedRanges: { from: number; to: number }[] = [];
  for (const [key, node] of inline) {
    const pieces = plan.inlinePieces[key];
    if (!pieces) throw new Error(`conversion plan is missing inline pieces at ${key}`);
    const reconstructed = pieces
      .map((piece) => {
        if (piece.kind === 'synthesize') return piece.text;
        if (
          piece.sourceFrom < 0 ||
          piece.sourceTo <= piece.sourceFrom ||
          piece.sourceTo > source.length
        ) {
          throw new Error(`conversion plan has an invalid retained range at ${key}`);
        }
        retainedRanges.push({ from: piece.sourceFrom, to: piece.sourceTo });
        return source.slice(piece.sourceFrom, piece.sourceTo);
      })
      .join('');
    if (reconstructed !== node.content)
      throw new Error(`conversion pieces do not reconstruct ${key}`);
  }
  retainedRanges.sort((a, b) => a.from - b.from || a.to - b.to);
  let cursor = 0;
  const consumed: { from: number; to: number }[] = [];
  for (const range of retainedRanges) {
    if (range.from < cursor)
      throw new Error('conversion plan duplicates retained source ownership');
    if (range.from > cursor) consumed.push({ from: cursor, to: range.from });
    cursor = range.to;
  }
  if (cursor < source.length) consumed.push({ from: cursor, to: source.length });
  if (JSON.stringify(consumed) !== JSON.stringify(plan.consumed)) {
    throw new Error('conversion plan does not classify all non-retained source');
  }
  return { firstInlineKey };
}

/** Applies a parser-authored conversion plan inside the triggering canonical draft. */
export function applyParserConversion(
  draft: TreeDraft,
  rootId: NodeId,
  sourceId: NodeId,
  source: string,
  plan: ParserConversionPlan,
  onSourceBookmarkMapper?: (mapper: (bookmark: Bookmark) => Bookmark) => void,
): boolean {
  const validated = validateTextPieces(source, plan);
  if (!validated) return false;
  if (typeof (draft as Partial<ParserTreeDraft>).sourcePieces !== 'function') {
    throw new Error('parser conversion requires draft source-piece mapping');
  }
  const parserDraft = draft as ParserTreeDraft;
  const location = findLocation(draft, rootId, sourceId);
  if (!location) throw new Error(`promotion source ${sourceId} is not active`);

  const draftSourcePieces = parserDraft.sourcePieces(sourceId);
  validateDraftSourcePieces(source, draftSourcePieces);
  const parsedNodes = new Map<string, MarkdownNode>();
  const composedByKey = new Map<string, readonly ComposedPiece[]>();
  const visitParsed = (node: MarkdownNode, path: number[]) => {
    const key = nodeKey(path);
    parsedNodes.set(key, node);
    if (isInlineNode(node)) {
      const pieces = composePieces(source, plan.inlinePieces[key]!, draftSourcePieces);
      if (composedText(source, pieces) !== node.content) {
        throw new Error(`composed parser pieces do not reconstruct ${key}`);
      }
      composedByKey.set(key, pieces);
    }
    for (const [index, child] of parsedChildren(node).entries()) {
      visitParsed(child, [...path, index]);
    }
  };
  visitParsed(plan.output, []);

  const ids = new Map<string, NodeId>();
  const visit = (node: MarkdownNode, path: number[]) => {
    const key = nodeKey(path);
    let id: NodeId;
    if (isInlineNode(node) && key === validated.firstInlineKey) {
      id = sourceId;
    } else {
      const pieces = composedByKey.get(key) ?? [];
      id = draft.create(specFor(node, isInlineNode(node) ? seedContent(pieces) : ''));
    }
    ids.set(key, id);
    for (const [index, child] of parsedChildren(node).entries()) visit(child, [...path, index]);
  };
  for (const [index, child] of parsedChildren(plan.output).entries()) visit(child, [index]);

  const outputTargetByKey = new Map<string, NodeId>();
  for (const [key, node] of parsedNodes) {
    if (isInlineNode(node)) outputTargetByKey.set(key, ids.get(key)!);
  }

  const sourceSegments: Array<{
    readonly from: number;
    readonly to: number;
    readonly nodeId: NodeId;
    readonly outputFrom: number;
    readonly outputTo: number;
  }> = [];
  for (const [key, node] of parsedNodes) {
    if (!isInlineNode(node)) continue;
    let outputOffset = 0;
    for (const piece of composedByKey.get(key) ?? []) {
      if (piece.kind !== 'synthesize') {
        const length = piece.to - piece.from;
        sourceSegments.push({
          from: piece.from,
          to: piece.to,
          nodeId: outputTargetByKey.get(key)!,
          outputFrom: outputOffset,
          outputTo: outputOffset + length,
        });
        outputOffset += length;
      } else {
        outputOffset += piece.text.length;
      }
    }
  }
  onSourceBookmarkMapper?.((bookmark) => {
    const offset = bookmark.offset;
    const left = sourceSegments.filter((piece) => piece.from < offset && offset <= piece.to);
    const right = sourceSegments.filter((piece) => piece.from <= offset && offset < piece.to);
    let segment = bookmark.affinity === 'left' ? left.at(-1) : right[0];
    if (!segment) segment = bookmark.affinity === 'left' ? right[0] : left.at(-1);
    if (!segment) {
      const previous = sourceSegments
        .filter((piece) => piece.to < offset)
        .toSorted((a, b) => b.to - a.to);
      const next = sourceSegments
        .filter((piece) => piece.from > offset)
        .toSorted((a, b) => a.from - b.from);
      segment = bookmark.affinity === 'left' ? (previous[0] ?? next[0]) : (next[0] ?? previous[0]);
    }
    if (!segment) return bookmark;
    const mappedOffset = Math.max(
      segment.outputFrom,
      Math.min(segment.outputTo, segment.outputFrom + offset - segment.from),
    );
    return Object.freeze({ ...bookmark, nodeId: segment.nodeId, offset: mappedOffset });
  });

  const events: TextEvent[] = [];
  const sourceDeletes = [...plan.consumed].map((range) => ({ from: range.from, to: range.to }));
  const firstSynthetic: SyntheticInsertion[] = [];
  let syntheticOrder = 0;
  for (const [key, node] of parsedNodes) {
    if (!isInlineNode(node)) continue;
    const pieces = composedByKey.get(key)!;
    const isFirstTarget = key === validated.firstInlineKey;
    const targetId = outputTargetByKey.get(key)!;
    let seedPrefix = 0;
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]!;
      if (piece.kind === 'synthesize') {
        if (isFirstTarget) {
          firstSynthetic.push({
            at: sourceBoundaryBefore(pieces, index),
            text: piece.text,
            order: syntheticOrder++,
          });
        } else {
          seedPrefix += piece.text.length;
        }
        continue;
      }
      if (piece.kind === 'inserted') {
        if (isFirstTarget) continue;
        sourceDeletes.push({ from: piece.from, to: piece.to });
        seedPrefix += piece.to - piece.from;
        continue;
      }
      if (!isFirstTarget) events.push({ from: piece.from, to: piece.to, targetId, at: seedPrefix });
    }
  }

  sourceDeletes.sort((a, b) => a.from - b.from || a.to - b.to);
  let deleteEnd = -1;
  for (const range of sourceDeletes) {
    if (range.from < deleteEnd) throw new Error('parser conversion source deletions overlap');
    deleteEnd = range.to;
  }
  const afterSourceDeletes = (offset: number): number => {
    let removed = 0;
    for (const range of sourceDeletes) {
      if (range.to <= offset) removed += range.to - range.from;
      else if (range.from < offset) removed += offset - range.from;
      else break;
    }
    return offset - removed;
  };
  for (const range of [...sourceDeletes].sort((a, b) => b.from - a.from)) {
    draft.spliceText(sourceId, { from: range.from, to: range.to, insert: '' });
  }

  const syntheticAfterDeletes = firstSynthetic.map((piece) => ({
    ...piece,
    at: afterSourceDeletes(piece.at),
  }));
  for (const piece of [...syntheticAfterDeletes].sort((a, b) => b.at - a.at || b.order - a.order)) {
    draft.spliceText(sourceId, { from: piece.at, to: piece.at, insert: piece.text });
  }

  const afterConversionEdits = (offset: number, edge: 'start' | 'end'): number => {
    const afterDeletes = afterSourceDeletes(offset);
    const insertedBefore = syntheticAfterDeletes
      .filter((piece) => (edge === 'start' ? piece.at <= afterDeletes : piece.at < afterDeletes))
      .reduce((length, piece) => length + piece.text.length, 0);
    return afterDeletes + insertedBefore;
  };
  const transfers = events.sort((a, b) => b.from - a.from || b.to - a.to);
  for (const event of transfers) {
    draft.transferInlineRange({
      source: sourceId,
      from: afterConversionEdits(event.from, 'start'),
      to: afterConversionEdits(event.to, 'end'),
      destination: event.targetId,
      at: event.at,
      affinity: 'left',
    });
  }

  const firstNode = parsedNodes.get(validated.firstInlineKey)!;
  if (firstNode.type !== draft.node(sourceId).type) {
    draft.convertInline(sourceId, {
      type: firstNode.type as 'paragraph' | 'section' | 'code-block',
      ...(firstNode.type === 'section' ? { marker: firstNode.marker } : {}),
      ...(firstNode.type === 'code-block' ? { info: firstNode.info } : {}),
      content: { mode: 'preserve' },
    });
  }

  const placeChildren = (node: MarkdownNode, path: number[]) => {
    const parentId = ids.get(nodeKey(path))!;
    for (const [index, child] of parsedChildren(node).entries()) {
      const childPath = [...path, index];
      draft.place(ids.get(nodeKey(childPath))!, parentId, null);
      placeChildren(child, childPath);
    }
  };
  for (const [index, child] of parsedChildren(plan.output).entries()) {
    const childPath = [index];
    draft.place(ids.get(nodeKey(childPath))!, location.parentId, location.before);
    placeChildren(child, childPath);
  }
  return true;
}
