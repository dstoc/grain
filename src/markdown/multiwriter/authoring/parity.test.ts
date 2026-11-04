import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { CanonicalDocument } from '../../canonical-model.js';
import { CanonicalWriter } from '../../canonical-actions.js';
import { serializeToString } from '../../block-serializer.js';
import { runCommand } from '../../../editing/test/run-command.js';
import type { Edit } from '../../../editing/outcomes.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { insertLineBreak } from '../../../editing/commands/insert-line-break.js';
import { enter } from '../../../editing/commands/enter.js';
import { deleteBackwardAtStart } from '../../../editing/commands/delete-backward.js';
import { indent } from '../../../editing/commands/indent.js';
import { outdent } from '../../../editing/commands/outdent.js';
import { wrap } from '../../../editing/commands/wrap.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { replaceBlocks } from '../../../editing/commands/replace-blocks.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';

interface Case {
  name: string;
  markdown: string;
  path?: readonly number[];
  command: Edit<{ nodeId: string }>;
}
const cases: Case[] = [
  {
    name: 'section demotion lifts multiple children',
    markdown: '# title\n\nfirst\n\nsecond',
    command: deleteBackwardAtStart,
  },
  {
    name: 'section deletion lifts multiple children',
    markdown: '# title\n\nfirst\n\nsecond',
    command: (ctx, { nodeId }) => deleteBlocks(ctx, { nodeIds: [nodeId] }),
  },
  ...[0, 2, 4].map((from) => ({
    name: `paragraph Enter ${from}`,
    markdown: 'abcd',
    command: ((ctx, { nodeId }) => insertParagraph(ctx, { nodeId, from })) as Edit<{
      nodeId: string;
    }>,
  })),
  {
    name: 'selected Enter',
    markdown: 'abcdef',
    command: (ctx, { nodeId }) => insertParagraph(ctx, { nodeId, from: 1, to: 4 }),
  },
  ...[0, 2, 4].map((from) => ({
    name: `task Enter ${from}`,
    markdown: '- [x] abcd',
    path: [0, 0, 0],
    command: ((ctx, { nodeId }) => insertParagraph(ctx, { nodeId, from })) as Edit<{
      nodeId: string;
    }>,
  })),
  {
    name: 'section Enter zero',
    markdown: '# title\n\nchild',
    command: (ctx, { nodeId }) => insertParagraph(ctx, { nodeId, from: 0 }),
  },
  {
    name: 'section Enter inside',
    markdown: '# title\n\nchild',
    command: (ctx, { nodeId }) => insertParagraph(ctx, { nodeId, from: 2 }),
  },
  {
    name: 'empty list Enter',
    markdown: '- \n',
    path: [0, 0, 0],
    command: (ctx, { nodeId }) => insertParagraph(ctx, { nodeId, from: 0 }),
  },
  {
    name: 'code Enter',
    markdown: '```\nabcd\n```',
    command: (ctx, { nodeId }) => enter(ctx, { nodeId, from: 2 }),
  },
  {
    name: 'code structural line break',
    markdown: '```\nabcd\n```',
    command: (ctx, { nodeId }) => insertLineBreak(ctx, { nodeId, from: 2 }),
  },
  {
    name: 'paragraph structural line break',
    markdown: 'abcd',
    command: (ctx, { nodeId }) => insertLineBreak(ctx, { nodeId, from: 2 }),
  },
  {
    name: 'quote Backspace unwrap',
    markdown: '> abcd',
    path: [0, 0],
    command: deleteBackwardAtStart,
  },
  {
    name: 'quote Backspace join',
    markdown: '> first\n>\n> second',
    path: [0, 1],
    command: deleteBackwardAtStart,
  },
  {
    name: 'section Backspace demote',
    markdown: '# title\n\nchild',
    command: deleteBackwardAtStart,
  },
  {
    name: 'section Backspace level',
    markdown: '## title\n\nchild',
    command: deleteBackwardAtStart,
  },
  { name: 'code Backspace demote', markdown: '```js\ncode\n```', command: deleteBackwardAtStart },
  {
    name: 'first root list Backspace',
    markdown: '- first\n- second',
    path: [0, 0, 0],
    command: deleteBackwardAtStart,
  },
  {
    name: 'list Backspace join',
    markdown: '- first\n- second',
    path: [0, 1, 0],
    command: deleteBackwardAtStart,
  },
  { name: 'indent paragraph', markdown: 'abcd', command: indent },
  { name: 'indent second item', markdown: '- first\n- second', path: [0, 1, 0], command: indent },
  {
    name: 'outdent item and following siblings',
    markdown: '- first\n- second\n- third',
    path: [0, 1, 0],
    command: outdent,
  },
  {
    name: 'wrap quote',
    markdown: 'abcd',
    command: (ctx, { nodeId }) => wrap(ctx, { nodeId, wrapper: 'block-quote' }),
  },
  {
    name: 'wrap list',
    markdown: 'abcd',
    command: (ctx, { nodeId }) => wrap(ctx, { nodeId, wrapper: 'list-item' }),
  },
  {
    name: 'paste after paragraph',
    markdown: 'abcd',
    command: (ctx, { nodeId }) =>
      insertMarkdown(ctx, { contextId: nodeId, markdown: '- one\n- two' }),
  },
  {
    name: 'paste into task sentinel',
    markdown: '- [x] ',
    path: [0, 0, 0],
    command: (ctx, { nodeId }) =>
      insertMarkdown(ctx, {
        contextId: nodeId,
        markdown: 'pasted\n\nsecond',
        replaceActiveEmptyTarget: true,
      }),
  },
  {
    name: 'paste under section',
    markdown: '# title',
    command: (ctx, { nodeId }) =>
      insertMarkdown(ctx, { contextId: nodeId, markdown: '# child\n\nbody' }),
  },
  {
    name: 'replace section text',
    markdown: '# title\n\nchild',
    command: (ctx, { nodeId }) => replaceBlocks(ctx, { nodeIds: [nodeId], text: 'changed' }),
  },
  {
    name: 'delete section lift children',
    markdown: '# title\n\nchild',
    command: (ctx, { nodeId }) => deleteBlocks(ctx, { nodeIds: [nodeId] }),
  },
  {
    name: 'delete final inline creates caret',
    markdown: 'last',
    command: (ctx, { nodeId }) => deleteBlocks(ctx, { nodeIds: [nodeId] }),
  },
];
for (const fixture of cases)
  test(`serial command parity: ${fixture.name}`, () => {
    const peer = commandReplica(commandGenesis(fixture.markdown));
    const canonical = CanonicalDocument.fromMarkdown(fixture.markdown, {
        documentId: 'parity',
        actionId: 'import',
        authorityEpoch: 'parity',
      }),
      writer = new CanonicalWriter(canonical);
    try {
      let view = peer.view().root,
        node = canonical.root;
      for (const i of fixture.path ?? [0]) {
        view = view.children[i]!;
        node = node.children[i]!;
      }
      const initial = peer
        .nodes()
        .flatMap((n) => n.fragments.filter((f) => f.visible).map((f) => f.range));
      const result = peer.editor.edit({ local: 'parity', group: 1n }, fixture.command, {
        nodeId: peer.handle(view),
      });
      const legacy = runCommand(
        writer,
        { actionId: 'command' },
        canonical.root.sharedId,
        undefined,
        fixture.command,
        { nodeId: node.sharedId },
      );
      expect(result.status === 'not-applicable').toBe(!legacy);
      expect(peer.markdown()).toBe(serializeToString(canonical.exportMarkdownTree()));
      const native = peer.document.publication.status().publication!.native;
      for (const range of initial)
        expect(native.lookup(range).reduce((n, p) => n + p.text.length, 0)).toBe(range.length);
      const reopened = commandReplica(peer.genesis, peer.document.store.encodeUpdate());
      try {
        expect(reopened.observe()).toEqual(peer.observe());
      } finally {
        reopened.close();
      }
    } finally {
      writer.close();
      canonical.close();
      peer.close();
    }
  });
