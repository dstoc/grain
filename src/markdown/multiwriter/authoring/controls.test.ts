import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { LocalEditResult } from './editor.js';
import type { ActionEnvelope, ActionId } from '../contracts.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';

function control(
  peer: CommandReplica,
  result: LocalEditResult,
  active: boolean,
  previous: ActionId | null = null,
): ActionId {
  if (result.status !== 'applied') throw new Error('Missing compiler action');
  const ready = peer.document.store.snapshot().ready,
    actor = result.action.actor;
  const sequence =
    ready
      .filter((a) => a.id.actor === actor)
      .reduce((n, a) => (a.id.sequence > n ? a.id.sequence : n), 0n) + 1n;
  const action: ActionEnvelope = {
    protocolVersion: 3,
    documentId: 'D',
    genesisId: 'G',
    id: { actor, sequence },
    lamport: ready.reduce((n, a) => (a.lamport > n ? a.lamport : n), 0n) + 1n,
    dependencies: [
      ...new Map(
        [
          ...peer.document.publication.status().publication!.heads,
          { actor, sequence: sequence - 1n },
        ].map((id) => [`${id.actor}:${id.sequence}`, id]),
      ).values(),
    ],
    groupId: { session: result.group.session, sequence: 10000n + sequence },
    allocations: [],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects: [
      {
        type: 'SetGroupActive',
        group: result.group,
        actions: [result.action],
        active,
        previousControl: previous,
      },
    ],
  };
  peer.document.certifyLocal(action);
  peer.document.store.append(action);
  peer.editor.refresh();
  return action.id;
}
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
