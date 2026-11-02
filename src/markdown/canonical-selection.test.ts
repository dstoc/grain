import { describe, expect, test } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import { CanonicalDocument } from './canonical-model.js';
import { createCanonicalTextAnchor, resolveCanonicalTextAnchor } from './canonical-selection.js';
import { insertParagraph, replaceSelectedBlocks } from '../editing/canonical-edits.js';

describe('canonical selection anchors', () => {
  test('maps a caret to the new owner when a paragraph is split', () => {
    const document = CanonicalDocument.fromMarkdown('abcdef');
    const writer = new CanonicalWriter(document);
    const original = document.root.children[0]!;
    const anchor = createCanonicalTextAnchor(document, {
      nodeId: original.sharedId,
      offset: 4,
      affinity: 'right',
    });

    const result = writer.edit({ actionId: 'split' }, (draft) =>
      insertParagraph(draft, document.root.sharedId, original.sharedId, 3),
    );

    expect('receipt' in result).toBe(true);
    const owner = resolveCanonicalTextAnchor(document, anchor);
    expect(document.node(owner.nodeId).content).toBe('def');
    expect(owner.offset).toBe(1);

    writer.close();
    document.close();
  });

  test('falls back to the next visible inline when the saved owner is detached', () => {
    const document = CanonicalDocument.fromMarkdown('abc\n\ndef');
    const writer = new CanonicalWriter(document);
    const [first, second] = document.root.children;
    const anchor = createCanonicalTextAnchor(document, {
      nodeId: first!.sharedId,
      offset: 2,
      affinity: 'right',
    });

    const result = writer.edit({ actionId: 'detach' }, (draft) => draft.detach(first!.sharedId));

    expect('receipt' in result).toBe(true);
    expect(resolveCanonicalTextAnchor(document, anchor)).toEqual({
      nodeId: second!.sharedId,
      offset: 2,
      affinity: 'right',
    });

    writer.close();
    document.close();
  });

  test('clamps an invalid UTF-16 point to a valid surrogate boundary', () => {
    const document = CanonicalDocument.fromMarkdown('😀x');
    const original = document.root.children[0]!;
    const anchor = createCanonicalTextAnchor(document, {
      nodeId: original.sharedId,
      offset: 1,
      affinity: 'left',
    });

    expect(anchor.bookmark.offset).toBe(0);
    expect(resolveCanonicalTextAnchor(document, anchor).offset).toBe(0);
    document.close();
  });

  test('restores the selected block range from a single canonical history entry', () => {
    const document = CanonicalDocument.fromMarkdown('alpha\n\nbeta');
    const writer = new CanonicalWriter(document);
    const [first, last] = document.root.children;
    const result = writer.edit({ actionId: 'replace' }, (draft) => {
      const anchor = draft.bookmark(first!.sharedId, 0, 'left');
      const focus = draft.bookmark(last!.sharedId, last!.content!.length, 'right');
      const actionFocus = replaceSelectedBlocks(
        draft,
        document.root.sharedId,
        [first!.sharedId, last!.sharedId],
        'combined',
      );
      return actionFocus ? { ...actionFocus, selection: { anchor, focus } } : undefined;
    });
    expect('receipt' in result).toBe(true);

    const undone = writer.undo('local', document.root.sharedId);
    expect(undone.status).toBe('applied');
    expect(undone.selectionAnchors).toBeDefined();
    expect(resolveCanonicalTextAnchor(document, undone.selectionAnchors!.anchor)).toMatchObject({
      nodeId: first!.sharedId,
      offset: 0,
    });
    expect(resolveCanonicalTextAnchor(document, undone.selectionAnchors!.focus)).toMatchObject({
      nodeId: last!.sharedId,
      offset: 4,
    });
    expect(document.root.children.map((node) => node.content)).toEqual(['alpha', 'beta']);

    writer.close();
    document.close();
  });
});
