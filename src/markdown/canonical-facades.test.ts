import { describe, expect, it } from 'vitest';

import { createBlockParser, parseBlocks } from './block-parser/api.js';
import { CanonicalDocument, CanonicalNode } from './canonical-model.js';
import { CanonicalWriter, type ActionRequest, type TreeDraft } from './canonical-actions.js';
import { serializeToString } from './block-serializer.js';
import { parse, parser } from './inline-parser/index.js';
import { isInlineNode, type MarkdownNode } from './node.js';

describe('documented source facades', () => {
  it('keeps the parser, inline, canonical, serializer, and node imports usable', () => {
    const blockParser = createBlockParser();
    blockParser.push('# Heading');
    expect(blockParser.finish().serialize().children?.[0]?.type).toBe('section');

    const tree: MarkdownNode = parseBlocks('text').node;
    expect(serializeToString(tree)).toBe('text\n');
    expect(isInlineNode(tree.children![0]!)).toBe(true);
    expect(parse('inline').rootNode.text).toBe('inline');
    expect(parser.parse('inline').rootNode.text).toBe('inline');

    const document = CanonicalDocument.fromMarkdown('text');
    expect(document.root).toBeInstanceOf(CanonicalNode);
    document.close();

    expect(CanonicalWriter).toBeTypeOf('function');
    const supportedTypes: [TreeDraft | undefined, ActionRequest | undefined] = [
      undefined,
      undefined,
    ];
    expect(supportedTypes).toEqual([undefined, undefined]);
  });
});
