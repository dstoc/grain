import { afterEach, expect, it, vi } from 'vitest';

import { CanonicalWriter } from '../../markdown/canonical-actions.js';
import { CanonicalDocument } from '../../markdown/canonical-model.js';
import type { CanonicalNode } from '../../markdown/canonical-model.js';
import { deleteBackwardAtStart } from './delete-backward.js';
import { indent } from './indent.js';
import { insertMarkdown } from './insert-markdown.js';
import { insertParagraph } from './insert-paragraph.js';
import { outdent } from './outdent.js';
import { runCommand } from '../test/run-command.js';

const open: { readonly document: CanonicalDocument; readonly writer: CanonicalWriter }[] = [];

afterEach(() => {
  for (const { writer, document } of open.splice(0)) {
    writer.close();
    document.close();
  }
});

function create(markdown: string) {
  const document = CanonicalDocument.fromMarkdown(markdown);
  const writer = new CanonicalWriter(document);
  open.push({ document, writer });
  return { document, writer };
}

function snapshot(document: CanonicalDocument): string {
  return JSON.stringify(document.canonicalSnapshot());
}

function findContent(root: CanonicalNode, content: string): CanonicalNode | undefined {
  if (root.content === content) return root;
  for (const child of root.children) {
    const found = findContent(child, content);
    if (found) return found;
  }
  return undefined;
}

it('keeps Backspace inside a quote scope instead of unwrapping the scope root', () => {
  const { document, writer } = create('> alpha\n\noutside');
  const quote = document.root.children[0]!;
  const paragraph = quote.children[0]!;
  const before = snapshot(document);
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: 'scoped-quote-backspace' },
    quote.sharedId,
    undefined,
    deleteBackwardAtStart,
    { nodeId: paragraph.sharedId },
  );

  expect(result).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(snapshot(document)).toBe(before);
  expect(quote.connected).toBe(true);
  expect(paragraph.parent?.sharedId).toBe(quote.sharedId);
  expect(writer.canUndo('local')).toBe(false);
});

it('keeps Enter in an empty quote scope under that quote through undo and redo', () => {
  const { document, writer } = create('> alpha\n\noutside');
  const quote = document.root.children[0]!;
  const paragraph = quote.children[0]!;
  writer.edit({ actionId: 'empty-quote-paragraph' }, (draft) => {
    draft.spliceText(paragraph.sharedId, {
      from: 0,
      to: paragraph.content?.length ?? 0,
      insert: '',
    });
  });

  const result = runCommand(
    writer,
    { actionId: 'scoped-empty-quote-enter' },
    quote.sharedId,
    undefined,
    insertParagraph,
    { nodeId: paragraph.sharedId, from: 0 },
  );
  expect(result).toBeDefined();
  expect(quote.connected).toBe(true);
  expect(document.root.children[0]!.sharedId).toBe(quote.sharedId);
  expect(quote.children.map((child) => child.sharedId)).toContain(paragraph.sharedId);
  expect(quote.children).toHaveLength(2);
  const afterEnter = snapshot(document);

  expect(writer.undo('local').status).toBe('applied');
  expect(quote.connected).toBe(true);
  expect(quote.children.map((child) => child.sharedId)).toEqual([paragraph.sharedId]);
  expect(writer.redo('local').status).toBe('applied');
  expect(snapshot(document)).toBe(afterEnter);
  expect(quote.connected).toBe(true);
});

it('does not outdent a list item beyond a list scope', () => {
  const { document, writer } = create('* alpha\n* beta\n\noutside');
  const list = document.root.children[0]!;
  const firstItem = list.children[0]!;
  const paragraph = firstItem.children[0]!;
  const before = snapshot(document);
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: 'scoped-list-outdent' },
    list.sharedId,
    undefined,
    outdent,
    { nodeId: paragraph.sharedId },
  );

  expect(result).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(snapshot(document)).toBe(before);
  expect(list.connected).toBe(true);
  expect(firstItem.parent?.sharedId).toBe(list.sharedId);
  expect(writer.canUndo('local')).toBe(false);
});

it('does not outdent a nested item beyond an item scope', () => {
  const { document, writer } = create('* parent\n  * nested\n* peer\n\noutside');
  const list = document.root.children[0]!;
  const scopeItem = list.children[0]!;
  const nestedList = scopeItem.children.find((child) => child.type === 'list')!;
  const nestedItem = nestedList.children[0]!;
  const paragraph = nestedItem.children[0]!;
  const before = snapshot(document);
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: 'scoped-nested-outdent' },
    scopeItem.sharedId,
    undefined,
    outdent,
    { nodeId: paragraph.sharedId },
  );

  expect(result).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(snapshot(document)).toBe(before);
  expect(scopeItem.connected).toBe(true);
  expect(nestedItem.parent?.sharedId).toBe(nestedList.sharedId);
  expect(writer.canUndo('local')).toBe(false);
});

it('does not indent a list scope root under a previous sibling outside the scope', () => {
  const { document, writer } = create('* alpha\n* beta\n\noutside');
  const list = document.root.children[0]!;
  const scopeItem = list.children[1]!;
  const paragraph = scopeItem.children[0]!;
  const before = snapshot(document);
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: 'scoped-list-indent' },
    scopeItem.sharedId,
    undefined,
    indent,
    { nodeId: paragraph.sharedId },
  );

  expect(result).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(snapshot(document)).toBe(before);
  expect(scopeItem.connected).toBe(true);
  expect(scopeItem.parent?.sharedId).toBe(list.sharedId);
  expect(writer.canUndo('local')).toBe(false);
});

it('preserves list-item caret bookmarks through scoped indent and outdent history', () => {
  const cases = [
    {
      action: 'scoped-indent-caret',
      markdown: '> - alpha\n> - beta\n\noutside',
      command: indent,
      expectedOwner: true,
    },
    {
      action: 'scoped-outdent-caret',
      markdown: '> - alpha\n>   - beta\n\noutside',
      command: outdent,
      expectedOwner: false,
    },
  ] as const;

  for (const { action, markdown, command, expectedOwner } of cases) {
    const { document, writer } = create(markdown);
    const quote = document.root.children[0]!;
    const paragraph = findContent(quote, 'beta')!;
    const selection = {
      anchor: { nodeId: paragraph.sharedId, offset: 3, affinity: 'left' as const },
      focus: { nodeId: paragraph.sharedId, offset: 3, affinity: 'right' as const },
    };

    const accepted = runCommand(writer, { actionId: action }, quote.sharedId, selection, command, {
      nodeId: paragraph.sharedId,
    });
    expect(accepted?.receipt.focus?.start?.offset).toBe(3);
    expect(accepted?.receipt.focus?.end?.offset).toBe(3);
    expect(paragraph.connected).toBe(true);
    expect(quote.connected).toBe(true);

    const movedOwner = paragraph.parent?.parent?.parent;
    expect(movedOwner?.type === 'list-item').toBe(expectedOwner);
    const undo = writer.undo('local');
    expect(undo.status).toBe('applied');
    expect(undo.focusAnchor?.bookmark.offset ?? undo.focus?.offset).toBe(3);
    expect(paragraph.parent?.parent?.parent?.type === 'list-item').toBe(
      action === 'scoped-outdent-caret',
    );

    const redo = writer.redo('local');
    expect(redo.status).toBe('applied');
    expect(redo.focusAnchor?.bookmark.offset ?? redo.focus?.offset).toBe(3);
    expect(paragraph.parent?.parent?.parent?.type === 'list-item').toBe(expectedOwner);
    expect(document.root.children[1]?.content).toBe('outside');
  }
});

it('splits an item-scoped paragraph inside its item and supports undo and redo', () => {
  const { document, writer } = create('* alpha\n* beta\n\noutside');
  const list = document.root.children[0]!;
  const scopeItem = list.children[0]!;
  const otherItem = list.children[1]!;
  const paragraph = scopeItem.children[0]!;
  const result = runCommand(
    writer,
    { actionId: 'scoped-item-enter' },
    scopeItem.sharedId,
    undefined,
    insertParagraph,
    { nodeId: paragraph.sharedId, from: 2 },
  );

  expect(result).toBeDefined();
  expect(scopeItem.connected).toBe(true);
  expect(scopeItem.parent?.sharedId).toBe(list.sharedId);
  expect(scopeItem.children.map((child) => child.content)).toEqual(['al', 'pha']);
  expect(list.children.map((item) => item.sharedId)).toEqual([
    scopeItem.sharedId,
    otherItem.sharedId,
  ]);
  const afterEnter = snapshot(document);

  expect(writer.undo('local').status).toBe('applied');
  expect(scopeItem.children.map((child) => child.content)).toEqual(['alpha']);
  expect(writer.redo('local').status).toBe('applied');
  expect(snapshot(document)).toBe(afterEnter);
  expect(scopeItem.connected).toBe(true);
});

it('pastes at the end of an item scope inside that item and supports undo and redo', () => {
  const { document, writer } = create('* alpha\n* beta\n\noutside');
  const list = document.root.children[0]!;
  const scopeItem = list.children[0]!;
  const paragraph = scopeItem.children[0]!;
  const result = runCommand(
    writer,
    { actionId: 'scoped-item-paste' },
    scopeItem.sharedId,
    undefined,
    insertMarkdown,
    { contextId: paragraph.sharedId, markdown: 'pasted' },
  );

  expect(result).toBeDefined();
  expect(scopeItem.connected).toBe(true);
  expect(scopeItem.parent?.sharedId).toBe(list.sharedId);
  expect(scopeItem.children.map((child) => child.content)).toEqual(['alpha', 'pasted']);
  expect(list.children).toHaveLength(2);
  const afterPasteChildIds = scopeItem.children.map((child) => child.sharedId);

  expect(writer.undo('local').status).toBe('applied');
  expect(scopeItem.children.map((child) => child.content)).toEqual(['alpha']);
  expect(writer.redo('local').status).toBe('applied');
  expect(scopeItem.children.map((child) => child.content)).toEqual(['alpha', 'pasted']);
  expect(scopeItem.children.map((child) => child.sharedId)).toEqual(afterPasteChildIds);
  expect(scopeItem.connected).toBe(true);
});
