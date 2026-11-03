import { describe, expect, test } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import { CanonicalDocument } from './canonical-model.js';
import { createCanonicalTextAnchor, resolveCanonicalTextAnchor } from './canonical-selection.js';
import { insertParagraph } from '../editing/commands/insert-paragraph.js';
import { replaceBlocks } from '../editing/commands/replace-blocks.js';
import { runCommand } from '../editing/test/run-command.js';
import type { EditSelection } from './semantic/selection.js';

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

    const result = runCommand(
      writer,
      { actionId: 'split' },
      document.root.sharedId,
      {
        anchor: { nodeId: original.sharedId, offset: 3, affinity: 'left' },
        focus: { nodeId: original.sharedId, offset: 3, affinity: 'right' },
      },
      insertParagraph,
      { nodeId: original.sharedId, from: 3 },
    );
    expect(result).toBeDefined();
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
    const selectionBefore: EditSelection = {
      nodeIds: [first!.sharedId, last!.sharedId],
      anchor: { nodeId: last!.sharedId, offset: last!.content!.length, affinity: 'right' },
      focus: { nodeId: first!.sharedId, offset: 0, affinity: 'left' },
    };
    const result = runCommand(
      writer,
      { actionId: 'replace' },
      document.root.sharedId,
      selectionBefore,
      replaceBlocks,
      { nodeIds: selectionBefore.nodeIds, text: 'combined' },
    );
    expect(result).toBeDefined();

    const undone = writer.undo('local', document.root.sharedId);
    expect(undone.status).toBe('applied');
    expect(undone.selectionAnchors).toBeDefined();
    expect(resolveCanonicalTextAnchor(document, undone.selectionAnchors!.anchor)).toMatchObject({
      nodeId: last!.sharedId,
      offset: 4,
    });
    expect(resolveCanonicalTextAnchor(document, undone.selectionAnchors!.focus)).toMatchObject({
      nodeId: first!.sharedId,
      offset: 0,
    });
    expect(document.root.children.map((node) => node.content)).toEqual(['alpha', 'beta']);

    writer.close();
    document.close();
  });
});
