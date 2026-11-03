import { afterEach, expect, it } from 'vitest';
import { CanonicalDocument } from '../../markdown/canonical-model.js';
import type { CanonicalNode } from '../../markdown/canonical-model.js';
import { CanonicalWriter } from '../../markdown/canonical-actions.js';
import { deleteBackwardAtStart } from './delete-backward.js';
import { indent } from './indent.js';
import { insertParagraph } from './insert-paragraph.js';
import { runCommand } from '../test/run-command.js';
import type { EditSelection } from '../../markdown/semantic/selection.js';
import { serializeToString } from '../../markdown/block-serializer.js';
import * as Y from 'yjs';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function create(markdown: string) {
  const document = CanonicalDocument.fromMarkdown(markdown);
  const writer = new CanonicalWriter(document);
  cleanup.push(() => {
    writer.close();
    document.close();
  });
  return { document, writer };
}
function walk(node: CanonicalNode): CanonicalNode[] {
  return [node, ...node.children.flatMap(walk)];
}
function accepted(result: ReturnType<CanonicalWriter['edit']>) {
  expect(result).toHaveProperty('receipt');
  if (!('receipt' in result)) throw new Error('edit was not accepted');
  return result;
}
function textSelection(nodeId: string, offset: number): EditSelection {
  return {
    anchor: { nodeId, offset, affinity: 'left' },
    focus: { nodeId, offset, affinity: 'right' },
  };
}
function serialized(document: CanonicalDocument): string {
  return serializeToString(document.exportMarkdownTree());
}
function spans(document: CanonicalDocument, id: string) {
  const node = document.canonicalSnapshot().nodes.find((item) => item.id === id);
  if (!node) throw new Error(`missing canonical node ${id}`);
  return node.spans.map((span) => ({ ...span }));
}
it('indenting the second list item nests it below the first without reversing order', () => {
  const { document, writer } = create('* alpha\n* beta\n');
  const list = document.root.children[0]!;
  const [first, second] = list.children;
  const beta = second!.children[0]!;
  const betaSpans = spans(document, beta.sharedId);
  const changed = runCommand(
    writer,
    { actionId: 'indent-beta' },
    document.root.sharedId,
    textSelection(beta.sharedId, 0),
    indent,
    { nodeId: beta.sharedId },
  );
  if (!changed) throw new Error('indent command was not applicable');
  expect(changed.receipt.focus?.start).toMatchObject({ nodeId: beta.sharedId, offset: 0 });
  expect(changed.receipt.focus?.end).toMatchObject({ nodeId: beta.sharedId, offset: 0 });
  expect(document.exportMarkdownTree()).toEqual({
    type: 'document',
    children: [
      {
        type: 'list',
        children: [
          {
            type: 'list-item',
            marker: '* ',
            children: [
              { type: 'paragraph', content: 'alpha' },
              {
                type: 'list',
                children: [
                  {
                    type: 'list-item',
                    marker: '* ',
                    children: [{ type: 'paragraph', content: 'beta' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(serialized(document)).toBe('* alpha\n  * beta\n');
  expect(spans(document, beta.sharedId)).toEqual(betaSpans);
  expect(list.children[0]!.sharedId).toBe(first!.sharedId);
  expect(writer.undo().status).toBe('applied');
  expect(list.children.map((item) => item.sharedId)).toEqual([first!.sharedId, second!.sharedId]);
  expect(serialized(document)).toBe('* alpha\n* beta\n');
  expect(spans(document, beta.sharedId)).toEqual(betaSpans);
  expect(writer.redo().status).toBe('applied');
  expect(serialized(document)).toBe('* alpha\n  * beta\n');
  expect(spans(document, beta.sharedId)).toEqual(betaSpans);
  expect(document.validate().valid).toBe(true);
});

it('Backspace joins a paragraph into the immediately preceding code block', () => {
  const { document, writer } = create('before\n\n```text\ncode\n```\n\nafter\n');
  const [before, code, after] = document.root.children;
  const codeSpans = spans(document, code!.sharedId);
  const afterSpans = spans(document, after!.sharedId);
  const original = serialized(document);
  const changed = runCommand(
    writer,
    { actionId: 'backspace-after-code' },
    document.root.sharedId,
    textSelection(after!.sharedId, 0),
    deleteBackwardAtStart,
    { nodeId: after!.sharedId },
  );
  if (!changed) throw new Error('Backspace command was not applicable');
  expect(changed.receipt.focus?.end).toMatchObject({ nodeId: code!.sharedId, offset: 4 });
  expect(document.root.children.map((node) => [node.type, node.content])).toEqual([
    ['paragraph', 'before'],
    ['code-block', 'codeafter'],
  ]);
  expect(document.root.children[1]!.sharedId).toBe(code!.sharedId);
  expect(before!.content).toBe('before');
  const joinedSpans = spans(document, code!.sharedId);
  expect(new Set(joinedSpans.map((span) => span.tapeId))).toEqual(
    new Set([...codeSpans, ...afterSpans].map((span) => span.tapeId)),
  );
  expect(serialized(document)).toBe('before\n\n```text\ncodeafter\n```\n');
  const undo = writer.undo();
  expect(undo.status).toBe('applied');
  expect(undo.focus).toMatchObject({ nodeId: after!.sharedId, offset: 0 });
  expect(serialized(document)).toBe(original);
  expect(spans(document, code!.sharedId)).toEqual(codeSpans);
  expect(spans(document, after!.sharedId)).toEqual(afterSpans);
  expect(writer.redo().status).toBe('applied');
  expect(serialized(document)).toBe('before\n\n```text\ncodeafter\n```\n');
  expect(spans(document, code!.sharedId)).toEqual(joinedSpans);
  expect(document.validate().valid).toBe(true);
});

it('Enter on the first empty ordered item preserves the remaining run start', () => {
  const { document, writer } = create('5. <!-- -->\n6. tail\n');
  const empty = walk(document.root).find(
    (node) => node.type === 'paragraph' && node.content === '',
  )!;
  const list = document.root.children[0]!;
  const firstItem = list.children[0]!;
  const tailItem = list.children[1]!;
  const tail = tailItem.children[0]!;
  const tailSpans = spans(document, tail.sharedId);
  const original = serialized(document);
  const changed = runCommand(
    writer,
    { actionId: 'exit-ordered-list' },
    document.root.sharedId,
    textSelection(empty.sharedId, 0),
    insertParagraph,
    { nodeId: empty.sharedId, from: 0 },
  );
  if (!changed) throw new Error('Enter command was not applicable');
  expect(changed.receipt.focus?.end).toMatchObject({ nodeId: empty.sharedId, offset: 0 });
  expect(document.root.children.map((node) => node.type)).toEqual(['paragraph', 'list']);
  expect(document.root.children[1]!.children[0]!.marker).toBe('5. ');
  expect(document.root.children[1]!.children[0]!.sharedId).toBe(tailItem.sharedId);
  expect(spans(document, tail.sharedId)).toEqual(tailSpans);
  const after = serialized(document);
  expect(after).toBe('<!-- -->\n\n5. tail\n');
  expect(writer.undo().status).toBe('applied');
  expect(serialized(document)).toBe(original);
  expect(document.root.children[0]!.children[0]!.sharedId).toBe(firstItem.sharedId);
  expect(spans(document, tail.sharedId)).toEqual(tailSpans);
  expect(writer.redo().status).toBe('applied');
  expect(serialized(document)).toBe(after);
  expect(document.validate().valid).toBe(true);
});

it('scoped typing undo follows the current tape owner after a join', () => {
  const { document, writer } = create('left\n\nright\n');
  const [left, right] = document.root.children;
  accepted(
    writer.edit({ actionId: 'type-right', sessionId: 'A' }, (draft) => {
      draft.spliceText(right!.sharedId, { from: 0, to: 0, insert: 'X' });
    }),
  );
  const joined = runCommand(
    writer,
    { actionId: 'join-right', sessionId: 'B' },
    document.root.sharedId,
    textSelection(right!.sharedId, 0),
    deleteBackwardAtStart,
    { nodeId: right!.sharedId },
  );
  if (!joined) throw new Error('Backspace command was not applicable');
  expect(left!.content).toBe('leftXright');
  expect(right!.connected).toBe(false);
  expect(writer.undo('A', left!.sharedId)).toMatchObject({ status: 'applied' });
  expect(left!.content).toBe('leftright');
  expect(writer.redo('A', left!.sharedId)).toMatchObject({ status: 'applied' });
  expect(left!.content).toBe('leftXright');
  expect(writer.undo('A', left!.sharedId)).toMatchObject({ status: 'applied' });
  expect(left!.content).toBe('leftright');
  expect(document.validate().valid).toBe(true);
});

it('unrelated list-item visibility does not block an independent property inverse', () => {
  const { document, writer } = create('```text\ncode\n```\n\n* item\n');
  const [code, list] = document.root.children;
  accepted(
    writer.edit({ actionId: 'demote-code', sessionId: 'A' }, (draft) => {
      draft.convertInline(code!.sharedId, { type: 'paragraph', content: { mode: 'preserve' } });
    }),
  );
  accepted(
    writer.edit({ actionId: 'detach-independent-list', sessionId: 'B' }, (draft) => {
      draft.detach(list!.sharedId);
    }),
  );
  expect(writer.undo('A').status).toBe('applied');
  expect(code!.type).toBe('code-block');
  expect(list!.connected).toBe(false);
});

it('undoing a later property change reopens the earlier resource token', () => {
  const { document, writer } = create('```text\ncode\n```\n');
  const code = document.root.children[0]!;
  accepted(
    writer.edit({ actionId: 'info-A', sessionId: 'A' }, (draft) =>
      draft.setInfo(code.sharedId, 'a'),
    ),
  );
  accepted(
    writer.edit({ actionId: 'info-B', sessionId: 'B' }, (draft) =>
      draft.setInfo(code.sharedId, 'b'),
    ),
  );
  expect(writer.undo('A')).toMatchObject({ status: 'blocked', reason: 'resource-conflict' });
  expect(writer.undo('B').status).toBe('applied');
  expect(writer.undo('A').status).toBe('applied');
  expect(code.info).toBe('text');
});

it('centralized concurrent overlapping deletes do not duplicate restored characters', () => {
  const { document, writer } = create('abcde\n');
  const node = document.root.children[0]!;
  const requests = [
    writer.prepareTextInput(
      node.sharedId,
      { from: 1, to: 3, insert: '' },
      { actionId: 'delete-bc', sessionId: 'A' },
    ),
    writer.prepareTextInput(
      node.sharedId,
      { from: 2, to: 4, insert: '' },
      { actionId: 'delete-cd', sessionId: 'B' },
    ),
  ];
  writer.admitSession('A');
  writer.admitSession('B');
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!;
    const result = writer.apply(request, {
      sessionId: index === 0 ? 'A' : 'B',
      authorityEpoch: request.authorityEpoch,
      sessionSequence: request.sessionSequence,
    });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') writer.publish(result.pending);
  }
  expect(node.content).toBe('ae');
  writer.undo('A');
  writer.undo('B');
  expect(node.content).toBe('abcde');
  const fresh = CanonicalDocument.open(document.checkpoint());
  try {
    expect(fresh.exportMarkdownTree()).toEqual(document.exportMarkdownTree());
  } finally {
    fresh.close();
  }
});

it('independently undoing disconnected replicas preserves the duplicate-restoration negative control', () => {
  const seed = new Y.Doc({ gc: false });
  seed.getText('text').insert(0, 'abcde');
  const replicas = [new Y.Doc({ gc: false }), new Y.Doc({ gc: false })];
  for (const doc of replicas) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  const managers = replicas.map((doc) => new Y.UndoManager(doc.getText('text')));
  try {
    replicas[0]!.getText('text').delete(1, 2);
    replicas[1]!.getText('text').delete(2, 2);
    managers[0]!.undo();
    managers[1]!.undo();
    const updates = replicas.map((doc) => Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(replicas[0]!, updates[1]!);
    Y.applyUpdate(replicas[1]!, updates[0]!);
    expect(replicas.map((doc) => doc.getText('text').toString())).toEqual(['abccde', 'abccde']);
    const fresh = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(fresh, Y.encodeStateAsUpdate(replicas[0]!));
      expect(fresh.getText('text').toString()).toBe('abccde');
    } finally {
      fresh.destroy();
    }
  } finally {
    managers.forEach((manager) => manager.destroy());
    replicas.forEach((doc) => doc.destroy());
    seed.destroy();
  }
});
