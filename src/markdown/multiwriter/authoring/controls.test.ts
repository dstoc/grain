import { control } from '../../../../test/multiwriter/commands/control.js';
import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { LocalEditResult } from './editor.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';

const session = { local: 'A', group: 1n };
test('real group controls retract and replay a compiler split after peer typing', () => {
  const genesis = commandGenesis(),
    a = commandReplica(genesis),
    b = commandReplica(genesis);
  try {
    const split = a.editor.edit(session, insertParagraph, {
      nodeId: a.handle(a.nodes()[0]!),
      from: 3,
    });
    b.receive(a.document.store.encodeUpdate());
    b.editor.edit({ local: 'B', group: 1n }, insertText, {
      nodeId: b.handle(b.nodes()[1]!),
      from: 1,
      text: 'X',
    });
    a.receive(b.document.store.encodeUpdate());
    const native = a.observe().native,
      identities = a.observe().identities;
    const undo = control(a, split, false);
    b.receive(a.document.store.encodeUpdate());
    expect(a.nodes().map((n) => n.content)).toEqual(['abcdXef']);
    expect(a.observe()).toEqual(b.observe());
    expect(a.observe().native).toEqual(native);
    expect(a.observe().identities).toEqual(identities);
    control(a, split, true, undo);
    b.receive(a.document.store.encodeUpdate());
    expect(a.nodes().map((n) => n.content)).toEqual(['abc', 'dXef']);
    expect(a.observe()).toEqual(b.observe());
  } finally {
    a.close();
    b.close();
  }
});
for (const operation of ['join', 'delete', 'paste', 'promotion', 'transfer'] as const)
  test(`group controls retain compiler ${operation} identities and exact footprint`, () => {
    const genesis = commandGenesis('first\n\nsecond'),
      a = commandReplica(genesis),
      b = commandReplica(genesis);
    try {
      const before = a.markdown();
      let result: LocalEditResult;
      switch (operation) {
        case 'join':
          result = a.editor.edit(session, joinWithPrevious, { nodeId: a.handle(a.nodes()[1]!) });
          break;
        case 'delete':
          result = a.editor.edit(session, deleteBlocks, { nodeIds: [a.handle(a.nodes()[1]!)] });
          break;
        case 'paste':
          result = a.editor.edit(session, insertMarkdown, {
            contextId: a.handle(a.nodes()[1]!),
            markdown: '- copied',
          });
          break;
        case 'promotion': {
          const nodeId = a.handle(a.nodes()[0]!);
          result = a.editor.edit(
            session,
            insertText,
            { nodeId, from: 0, text: '# ' },
            { promote: nodeId },
          );
          break;
        }
        case 'transfer':
          result = a.editor.edit(
            session,
            (ctx, { source, destination }) => {
              ctx.draft.transferInlineRange({
                source,
                from: 1,
                to: 3,
                destination,
                at: 2,
                affinity: 'right',
              });
              return { status: 'handled' };
            },
            { source: a.handle(a.nodes()[0]!), destination: a.handle(a.nodes()[1]!) },
          );
          break;
      }
      if (result.status !== 'applied') throw new Error('Expected command');
      expect(result.footprint.effects).toEqual(result.envelope.effects);
      expect(result.footprint.allocations).toEqual(result.envelope.allocations);
      const after = a.markdown(),
        native = a.observe().native;
      b.receive(a.document.store.encodeUpdate());
      expect(b.observe()).toEqual(a.observe());
      const undo = control(a, result, false);
      expect(a.markdown()).toBe(before);
      expect(a.observe().native).toEqual(native);
      control(a, result, true, undo);
      expect(a.markdown()).toBe(after);
      b.receive(a.document.store.encodeUpdate());
      expect(a.observe()).toEqual(b.observe());
      const reopened = commandReplica(genesis, a.document.store.encodeUpdate());
      try {
        expect(reopened.observe()).toEqual(a.observe());
      } finally {
        reopened.close();
      }
    } finally {
      a.close();
      b.close();
    }
  });

test('local commands continue the same actor chain after replicated group controls', () => {
  const p = commandReplica(commandGenesis());
  try {
    const edit = p.editor.edit(session, insertText, {
      nodeId: p.handle(p.nodes()[0]),
      from: 0,
      text: 'X',
    });
    const undo = control(p, edit, false);
    const next = p.editor.edit({ local: 'A', group: 2n }, insertText, {
      nodeId: p.handle(p.nodes()[0]),
      from: 0,
      text: 'Y',
    });
    if (next.status !== 'applied') throw new Error();
    expect(next.action).toEqual({ ...undo, sequence: undo.sequence + 1n });
    expect(p.markdown()).toBe('Yabcdef\n');
  } finally {
    p.close();
  }
});
