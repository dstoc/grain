import { afterEach, expect, it, vi } from 'vitest';

import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument } from '../markdown/canonical-model.js';
import { deleteBackwardAtStart } from './commands/delete-backward.js';
import { insertParagraph } from './commands/insert-paragraph.js';
import { NOT_APPLICABLE, type Edit } from './outcomes.js';
import { prepareEdit } from './prepare-edit.js';
import { runCommand } from './test/run-command.js';

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

it('prepares a not-applicable command once and does not submit or record history', () => {
  const { document, writer } = create('first\n\nsecond');
  const first = document.root.children[0]!;
  const before = snapshot(document);
  const prepare = vi.spyOn(writer, 'prepareCommand');
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: 'no-previous-block' },
    document.root.sharedId,
    undefined,
    deleteBackwardAtStart,
    { nodeId: first.sharedId },
  );

  expect(result).toBeUndefined();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  expect(snapshot(document)).toBe(before);
  expect(writer.canUndo('local')).toBe(false);
  expect(writer.canRedo('local')).toBe(false);
});

it('rejects a command that mutates its draft before returning not-applicable', () => {
  const { document, writer } = create('first');
  const before = snapshot(document);
  const invalidCommand: Edit<undefined> = (context) => {
    context.draft.create({ type: 'paragraph', content: 'uncommitted' });
    return NOT_APPLICABLE;
  };

  expect(() =>
    prepareEdit(
      writer,
      { actionId: 'invalid-no-op' },
      document.root.sharedId,
      undefined,
      invalidCommand,
      undefined,
    ),
  ).toThrow('not-applicable edit changed its draft');
  expect(snapshot(document)).toBe(before);
  expect(writer.canUndo('local')).toBe(false);
});

it('rejects out-of-scope targets and surrogate-splitting offsets before submission', () => {
  const { document, writer } = create('> 😀x\n\noutside');
  const [scopeRoot, outside] = document.root.children;
  const [paragraph] = scopeRoot!.children;
  const before = snapshot(document);
  const apply = vi.spyOn(writer, 'apply');

  expect(() =>
    runCommand(
      writer,
      { actionId: 'outside-scope' },
      scopeRoot!.sharedId,
      undefined,
      insertParagraph,
      { nodeId: outside!.sharedId, from: 0 },
    ),
  ).toThrow(/outside edit scope/);
  expect(() =>
    runCommand(
      writer,
      { actionId: 'split-surrogate' },
      scopeRoot!.sharedId,
      undefined,
      insertParagraph,
      { nodeId: paragraph!.sharedId, from: 1 },
    ),
  ).toThrow(/surrogate pair/);
  expect(apply).not.toHaveBeenCalled();
  expect(snapshot(document)).toBe(before);
  expect(writer.canUndo('local')).toBe(false);
});
