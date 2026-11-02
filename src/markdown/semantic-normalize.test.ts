import { afterEach, describe, expect, it } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import { CanonicalDocument } from './canonical-model.js';
import type { DocumentNode } from './node.js';
import { MarkdownTree } from './view-model.js';

const documents: CanonicalDocument[] = [];
const writers: CanonicalWriter[] = [];

afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
  for (const document of documents.splice(0)) document.close();
});

describe('shared semantic normalization', () => {
  it('produces the same normalized tree for parser construction and a canonical edit', () => {
    const source: DocumentNode = {
      type: 'document',
      children: [
        { type: 'section', marker: '##', content: 'nested' },
        { type: 'paragraph', content: 'inside nested' },
        { type: 'section', marker: '#', content: 'root' },
        { type: 'paragraph', content: 'inside root' },
        {
          type: 'list',
          children: [{ type: 'list-item', marker: '4. ', children: [] }],
        },
        {
          type: 'list',
          children: [{ type: 'list-item', marker: '9. ', children: [] }],
        },
        { type: 'block-quote', marker: '> ', children: [] },
      ],
    };
    const parserTree = new MarkdownTree(structuredClone(source)).serialize();
    const canonical = CanonicalDocument.fromParsed(source, {
      documentId: 'shared-normalization-document',
      actionId: 'shared-normalization-import',
      authorityEpoch: 'shared-normalization-epoch',
    });
    const writer = new CanonicalWriter(canonical);
    documents.push(canonical);
    writers.push(writer);

    const section = canonical.root.children[0]!;
    const result = writer.edit({ actionId: 'normalize-canonical-tree' }, (draft) => {
      draft.setMarker(section.sharedId, section.marker!);
    });

    expect(result).toHaveProperty('receipt');
    expect(canonical.exportMarkdownTree()).toEqual(parserTree);
  });

  it('keeps parent and sibling lookups current as a draft moves and detaches nodes', () => {
    const canonical = CanonicalDocument.fromMarkdown('a\n\nb\n\nc', {
      documentId: 'draft-navigation-document',
      actionId: 'draft-navigation-import',
      authorityEpoch: 'draft-navigation-epoch',
    });
    const writer = new CanonicalWriter(canonical);
    documents.push(canonical);
    writers.push(writer);
    const [first, middle, last] = canonical.root.children;
    expect(first && middle && last).toBeTruthy();

    const result = writer.edit({ actionId: 'draft-navigation' }, (draft) => {
      const root = canonical.root.sharedId;
      draft.place(last!.sharedId, root, first!.sharedId);
      expect(draft.parentOf(last!.sharedId)).toBe(root);
      expect(draft.previousSiblingOf(last!.sharedId)).toBeUndefined();
      expect(draft.nextSiblingOf(last!.sharedId)).toBe(first!.sharedId);
      expect(draft.previousSiblingOf(first!.sharedId)).toBe(last!.sharedId);
      expect(draft.nextSiblingOf(first!.sharedId)).toBe(middle!.sharedId);

      draft.detach(middle!.sharedId);
      expect(draft.parentOf(middle!.sharedId)).toBeUndefined();
      expect(draft.nextSiblingOf(last!.sharedId)).toBe(first!.sharedId);
    });

    expect(result).toHaveProperty('receipt');
  });
});
