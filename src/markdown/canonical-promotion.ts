import { isInlineNode, type InlineNode, type MarkdownNode } from './node.js';
import type { ParserConversionPlan } from './block-parser/types.js';
import type { NodeId } from './canonical-model.js';
import type { DraftNode, NodeSpec, TreeDraft } from './canonical-actions.js';

interface InlineTarget {
  readonly id: NodeId;
  readonly pieces: ParserConversionPlan['inlinePieces'][string];
}

interface TextEvent {
  readonly from: number;
  readonly to: number;
  readonly targetId?: NodeId;
  readonly at?: number;
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

function syntheticContent(
  pieces: readonly ParserConversionPlan['inlinePieces'][string][number][],
): string {
  return pieces
    .filter(
      (piece): piece is Extract<(typeof pieces)[number], { kind: 'synthesize' }> =>
        piece.kind === 'synthesize',
    )
    .map((piece) => piece.text)
    .join('');
}

function specFor(node: MarkdownNode, syntheticText = ''): NodeSpec {
  const spec: NodeSpec = {
    type: node.type,
    ...(isInlineNode(node) ? { content: syntheticText } : {}),
    ...(node.type === 'section' || node.type === 'list-item' || node.type === 'block-quote'
      ? { marker: node.marker }
      : {}),
    ...(node.type === 'list-item' ? { checked: node.checked ?? null } : {}),
    ...(node.type === 'code-block' ? { info: node.info } : {}),
  };
  return spec;
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
): boolean {
  const validated = validateTextPieces(source, plan);
  if (!validated) return false;
  const location = findLocation(draft, rootId, sourceId);
  if (!location) throw new Error(`promotion source ${sourceId} is not active`);

  const parsedNodes = new Map<string, MarkdownNode>();
  const ids = new Map<string, NodeId>();
  const targets: InlineTarget[] = [];
  const visit = (node: MarkdownNode, path: number[]) => {
    const key = nodeKey(path);
    parsedNodes.set(key, node);
    let id: NodeId;
    if (isInlineNode(node) && key === validated.firstInlineKey) {
      id = sourceId;
      targets.push({ id, pieces: plan.inlinePieces[key]! });
    } else {
      const pieces = plan.inlinePieces[key] ?? [];
      id = draft.create(specFor(node, isInlineNode(node) ? syntheticContent(pieces) : ''));
      if (isInlineNode(node)) targets.push({ id, pieces });
    }
    ids.set(key, id);
    for (const [index, child] of parsedChildren(node).entries()) visit(child, [...path, index]);
  };
  for (const [index, child] of parsedChildren(plan.output).entries()) visit(child, [index]);
  if (!targets.length) return false;

  const firstTarget = targets[0]!;
  if (firstTarget.id !== sourceId)
    throw new Error('the first parsed inline node must retain source identity');

  const outputTargetByKey = new Map<string, NodeId>();
  for (const [key, node] of parsedNodes) {
    if (isInlineNode(node)) outputTargetByKey.set(key, ids.get(key)!);
  }

  const events: TextEvent[] = [];
  for (const [key, node] of parsedNodes) {
    if (!isInlineNode(node)) continue;
    const pieces = plan.inlinePieces[key]!;
    let syntheticPrefix = 0;
    for (const piece of pieces) {
      if (piece.kind === 'synthesize') {
        syntheticPrefix += piece.text.length;
        continue;
      }
      events.push({
        from: piece.sourceFrom,
        to: piece.sourceTo,
        targetId: outputTargetByKey.get(key)!,
        at: syntheticPrefix,
      });
    }
  }
  for (const range of [...plan.consumed].sort((a, b) => b.from - a.from)) {
    draft.spliceText(sourceId, { from: range.from, to: range.to, insert: '' });
  }

  const firstPieces = firstTarget.pieces;
  let firstOutputOffset = 0;
  const firstSynthetic: { readonly at: number; readonly text: string }[] = [];
  let previousSourceEnd = -1;
  for (const piece of firstPieces) {
    if (piece.kind === 'synthesize') {
      firstSynthetic.push({ at: firstOutputOffset, text: piece.text });
      firstOutputOffset += piece.text.length;
    } else {
      if (piece.sourceFrom < previousSourceEnd) {
        throw new Error('the first parsed inline output reorders retained source');
      }
      previousSourceEnd = piece.sourceTo;
      firstOutputOffset += piece.sourceTo - piece.sourceFrom;
    }
  }
  for (const piece of firstSynthetic.sort((a, b) => b.at - a.at)) {
    draft.spliceText(sourceId, { from: piece.at, to: piece.at, insert: piece.text });
  }

  const firstSyntheticLength = firstSynthetic.reduce(
    (length, piece) => length + piece.text.length,
    0,
  );
  const transfers = events
    .filter((event): event is TextEvent & { readonly targetId: NodeId } =>
      Boolean(event.targetId && event.targetId !== sourceId),
    )
    .sort((a, b) => b.from - a.from || b.to - a.to);
  for (const event of transfers) {
    const consumedBefore = plan.consumed
      .filter((range) => range.to <= event.from)
      .reduce((length, range) => length + range.to - range.from, 0);
    const from = event.from - consumedBefore + firstSyntheticLength;
    draft.transferInlineRange({
      source: sourceId,
      from,
      to: from + event.to - event.from,
      destination: event.targetId,
      at: event.at ?? 0,
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
