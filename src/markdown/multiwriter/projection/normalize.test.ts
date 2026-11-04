import { expect, test } from 'vitest';
import type { DocumentNode, MarkdownNode } from '../../node.js';
import { ConstructionTree } from '../../semantic/construction-tree.js';
import { serializeToString } from '../../block-serializer.js';
import type { NodeId, OccurrenceId } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { normalizeProjection, projectionDocument, serializeProjection } from './index.js';
import type { ViewNode } from './index.js';

function view(document: DocumentNode): ViewNode {
  let ordinal = 0;
  function convert(
    node: MarkdownNode,
    parent: NodeId | null,
    previous: OccurrenceId | null,
  ): { node: ViewNode; occurrence: OccurrenceId } {
    const id: NodeId = {
      kind: 'node',
      birth: { type: 'genesis', genesisId: 'G' },
      ordinal: ordinal++,
    };
    const occurrence: OccurrenceId = { kind: 'occurrence', birth: id.birth, ordinal: ordinal++ };
    const slot = parent ? { parent, predecessor: previous } : null;
    let predecessor: OccurrenceId | null = null;
    const children = (node.children ?? []).map((child) => {
      const result = convert(child, id, predecessor);
      predecessor = result.occurrence;
      return result.node;
    });
    const edge = slot ? { type: 'edge' as const, child: id, slot } : null;
    return {
      occurrence,
      node: {
        type: node.type,
        content: 'content' in node ? node.content : '',
        marker: 'marker' in node ? node.marker : null,
        info: node.type === 'code-block' ? node.info : null,
        checked: node.type === 'list-item' ? (node.checked ?? null) : null,
        children,
        origin: { type: 'node', representative: id, constituents: [id] },
        edge,
        fragments: [],
        boundaries: [],
        wrappers:
          edge && ['list', 'block-quote', 'list-item'].includes(node.type)
            ? [
                {
                  node: id,
                  edge,
                  start: { parent: id, predecessor: null },
                  end: { parent: id, predecessor },
                },
              ]
            : [],
      },
    };
  }
  return convert(document, null, null).node;
}
const paragraph = (content = 'text'): MarkdownNode => ({ type: 'paragraph', content });
const section = (marker: string, children: MarkdownNode[] = []): MarkdownNode => ({
  type: 'section',
  marker,
  content: marker,
  children,
});
const quote = (children: MarkdownNode[]): MarkdownNode => ({
  type: 'block-quote',
  marker: '> ',
  children,
});
const list = (marker = '- ', checked?: boolean): MarkdownNode => ({
  type: 'list',
  children: [
    {
      type: 'list-item',
      marker,
      ...(checked === undefined ? {} : { checked }),
      children: [paragraph('item')],
    },
  ],
});
function descendants(node: ViewNode): ViewNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function check(document: DocumentNode): void {
  const baseline = new ConstructionTree(document);
  baseline.normalize({ createEmptyRoot: false });
  const original = view(document);
  const before = structuredClone(original);
  const normalized = normalizeProjection(original);
  const result = { root: normalized, emptyRoot: null };
  expect(projectionDocument(result)).toEqual(baseline.serialize());
  expect(serializeProjection(result)).toBe(
    baseline.root.children.length ? serializeToString(baseline.serialize()) : '',
  );
  expect(original).toEqual(before);
  const originalEdges = new Map(
    descendants(original).map((node) => [resourceKey(node.origin.representative), node.edge]),
  );
  for (const node of descendants(normalized)) {
    expect(node.edge).toEqual(originalEdges.get(resourceKey(node.origin.representative)));
    expect(node.origin.constituents.every((id) => originalEdges.has(resourceKey(id)))).toBe(true);
  }
}

test('shares the exact forward rule order on generated section/list/quote combinations', () => {
  const variants = [
    paragraph(),
    paragraph(''),
    section('#'),
    section('##', [paragraph('body')]),
    list('7. '),
    list('* ', true),
    quote([paragraph('quoted')]),
    quote([]),
  ];
  for (const a of variants)
    for (const b of variants)
      for (const c of [paragraph('end'), section('#'), list('2) ')])
        check({ type: 'document', children: structuredClone([a, b, c]) });
});

test('covers first-section containment, mixed markers, large BigInt numbering and empty cascades', () => {
  check({
    type: 'document',
    children: [
      section('##', [paragraph('body')]),
      section('#'),
      paragraph('tail'),
      section('###'),
      section('##'),
      section('#'),
    ],
  });
  check({
    type: 'document',
    children: [
      list('999999999999999999999999999999999999999) '),
      list('- ', false),
      list('2. ', true),
      paragraph(''),
    ],
  });
  check({
    type: 'document',
    children: [
      quote([
        { type: 'list', children: [{ type: 'list-item', marker: '- ', children: [quote([])] }] },
      ]),
    ],
  });
  check({ type: 'document', children: [] });
});

test('merging retains every wrapper constituent and original child edge', () => {
  const original = view({
    type: 'document',
    children: [quote([paragraph('a')]), quote([paragraph('b')]), quote([paragraph('c')])],
  });
  const normalized = normalizeProjection(original);
  const group = normalized.children[0]!;
  expect(group.origin.representative).toEqual(original.children[0]!.origin.representative);
  expect(group.origin.constituents).toEqual(
    original.children.map((node) => node.origin.representative),
  );
  expect(group.wrappers.map((wrapper) => wrapper.node)).toEqual(group.origin.constituents);
  expect(group.children.map((node) => node.edge!.slot.parent)).toEqual(group.origin.constituents);
});
