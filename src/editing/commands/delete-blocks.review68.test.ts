import { afterEach, expect, it } from 'vitest';

import { CanonicalDocument } from '../../markdown/canonical-model.js';
import type { CanonicalNode } from '../../markdown/canonical-model.js';
import { CanonicalWriter } from '../../markdown/canonical-actions.js';
import { deleteBlocks } from './delete-blocks.js';
import { replaceBlocks } from './replace-blocks.js';
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

function walk(node: CanonicalNode): CanonicalNode[] {
  return [node, ...node.children.flatMap(walk)];
}

it.each([
  ['quote', '> alpha\n\noutside', 'block-quote'],
  ['list', '* alpha\n\noutside', 'list'],
  ['list-item', '* alpha\n* beta\n\noutside', 'list-item'],
] as const)('preserves the %s scope and caret through undo and redo', (_, source, kind) => {
  const { document, writer } = create(source);
  const scope = walk(document.root).find((node) => node.type === kind)!;
  const target = walk(scope).find((node) => node.type === 'paragraph')!;
  const outside = walk(document.root).find((node) => node.content === 'outside')!;
  const before = document.exportMarkdownTree();

  const changed = runCommand(
    writer,
    { actionId: 'scoped-delete' },
    scope.sharedId,
    undefined,
    deleteBlocks,
    { nodeIds: [target.sharedId] },
  );

  expect(changed).toBeDefined();
  expect(scope.connected).toBe(true);
  expect(target.connected).toBe(false);
  expect(walk(document.root).find((node) => node.content === 'outside')?.sharedId).toBe(
    outside.sharedId,
  );
  const focus = changed!.receipt.focus?.end;
  expect(focus).toMatchObject({ offset: 0 });
  const caret = walk(scope).find((node) => node.sharedId === focus!.nodeId)!;
  expect(caret.type).toBe('paragraph');
  expect(caret.content).toBe('');
  const after = document.exportMarkdownTree();

  expect(writer.undo().status).toBe('applied');
  expect(document.exportMarkdownTree()).toEqual(before);
  expect(scope.connected).toBe(true);
  expect(target.connected).toBe(true);
  expect(walk(document.root).find((node) => node.content === 'outside')?.sharedId).toBe(
    outside.sharedId,
  );

  expect(writer.redo().status).toBe('applied');
  expect(document.exportMarkdownTree()).toEqual(after);
  expect(scope.connected).toBe(true);
  expect(target.connected).toBe(false);
  expect(walk(scope).find((node) => node.sharedId === focus!.nodeId)?.content).toBe('');
  expect(walk(document.root).find((node) => node.content === 'outside')?.sharedId).toBe(
    outside.sharedId,
  );
});

it('keeps the scoped quote through the prior empty replacement behavior', () => {
  const { document, writer } = create('> alpha\n\noutside');
  const scope = document.root.children[0]!;
  const target = scope.children[0]!;
  const changed = runCommand(
    writer,
    { actionId: 'scoped-replace' },
    scope.sharedId,
    undefined,
    replaceBlocks,
    { nodeIds: [target.sharedId], text: '' },
  );

  expect(scope.connected).toBe(true);
  expect(scope.children[0]!.sharedId).toBe(target.sharedId);
  expect(scope.children[0]!.content).toBe('');
  expect(changed?.receipt.focus?.end).toBeDefined();
});

it.each(['* alpha\n* beta', '> alpha\n>\n> beta', '# First\n\nBody\n\n## Child\n\nTail'])(
  'still deletes all nested blocks in document scope and replays history: %s',
  (source) => {
    const { document, writer } = create(source);
    const original = document.exportMarkdownTree();
    const targets = walk(document.root).filter((node) =>
      ['section', 'paragraph', 'code-block'].includes(node.type),
    );
    const changed = runCommand(
      writer,
      { actionId: 'delete-all' },
      document.root.sharedId,
      undefined,
      deleteBlocks,
      { nodeIds: targets.map((node) => node.sharedId) },
    );

    expect(changed).toBeDefined();
    expect(document.exportMarkdownTree()).toEqual({
      type: 'document',
      children: [{ type: 'paragraph', content: '' }],
    });
    const sentinelId = document.root.children[0]!.sharedId;
    expect(changed!.receipt.focus?.end?.nodeId).toBe(sentinelId);
    expect(writer.undo().status).toBe('applied');
    expect(document.exportMarkdownTree()).toEqual(original);
    expect(writer.redo().status).toBe('applied');
    expect(document.root.children[0]!.sharedId).toBe(sentinelId);
  },
);
