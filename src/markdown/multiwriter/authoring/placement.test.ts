import { expect, test } from 'vitest';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import type { LocalEditResult } from './editor.js';
import { resourceKey } from '../layout/index.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { indent, insertMarkdown, insertParagraph, insertText, interpretMarkdown } from './index.js';
import { parseBlocks } from '../../block-parser/api.js';
import { NativeFixture } from '../ownership/test-fixtures.js';

const session = { local: 'review', group: 1n };

function orderedIdentities(p: CommandReplica): string[] {
  return p
    .nodes()
    .flatMap((n) =>
      n.fragments
        .filter((f) => f.visible)
        .flatMap((f) =>
          Array.from(
            { length: f.range.length },
            (_, i) => `${resourceKey(f.range.tape)}:${f.range.client}:${f.range.clock + i}`,
          ),
        ),
    );
}

function verifyReplay(p: CommandReplica, result: LocalEditResult, before: string) {
  if (result.status !== 'applied') throw new Error('Missing compiler action');
  expect(result.footprint).toEqual({
    allocations: result.envelope.allocations,
    effects: result.envelope.effects,
  });
  const after = p.observe(),
    ordered = orderedIdentities(p),
    envelope = structuredClone(result.envelope),
    updates = [p.document.store.encodeUpdate()],
    peer = commandReplica(p.genesis);
  const stop = p.document.store.onUpdate((bytes) => updates.push(bytes.slice()));
  const checkPeer = () => {
    const bytes = p.document.store.encodeUpdate();
    peer.receive(bytes);
    peer.receive(bytes);
    expect(peer.observe()).toEqual(p.observe());
  };
  try {
    checkPeer();
    const undo = control(p, result, false);
    expect(p.markdown()).toBe(before);
    expect(p.observe().native).toEqual(after.native);
    checkPeer();
    control(p, result, true, undo);
    expect(p.markdown()).toBe(after.markdown);
    expect(p.view()).toEqual(after.tree);
    expect(orderedIdentities(p)).toEqual(ordered);
    expect(p.observe().native).toEqual(after.native);
    expect(
      p.document.store
        .snapshot()
        .ready.find(
          (a) => a.id.actor === result.action.actor && a.id.sequence === result.action.sequence,
        ),
    ).toEqual(envelope);
    checkPeer();
    const cold = commandReplica(p.genesis);
    try {
      // Original carrier updates, delivered with controls before their missing prefix.
      for (const bytes of updates.toReversed()) cold.receive(bytes);
      for (const bytes of updates) cold.receive(bytes);
      expect(cold.observe()).toEqual(p.observe());
    } finally {
      cold.close();
    }
  } finally {
    stop();
    peer.close();
  }
}

for (const from of [0, 3, 6])
  for (const combined of [true, false]) {
    test(`Enter at ${from} then indent the new tail: ${combined ? 'same action' : 'separate actions control'}`, () => {
      const p = commandReplica(commandGenesis());
      try {
        const nodeId = p.handle(p.nodes()[0]);
        const before = p.markdown(),
          identities = orderedIdentities(p);
        let result: LocalEditResult | undefined;
        if (combined) {
          result = p.editor.edit(
            session,
            (ctx) => {
              const split = insertParagraph(ctx, { nodeId, from });
              if (split.status !== 'handled' || !split.focus)
                throw new Error('Missing split focus');
              return indent(ctx, { nodeId: split.focus.nodeId });
            },
            undefined,
          );
        } else {
          p.editor.edit(session, insertParagraph, { nodeId, from });
          p.editor.edit(session, indent, { nodeId: p.handle(p.nodes()[from === 0 ? 0 : 1]) });
        }
        expect(p.markdown()).toBe(
          from === 0
            ? '* <!-- -->\n\n\nabcdef\n'
            : from === 6
              ? 'abcdef\n* <!-- -->\n'
              : 'abc\n* def\n',
        );
        expect(orderedIdentities(p)).toEqual(identities);
        if (result) verifyReplay(p, result, before);
        const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
        try {
          expect(cold.observe()).toEqual(p.observe());
        } finally {
          cold.close();
        }
      } finally {
        p.close();
      }
    });
  }

for (const combined of [true, false]) {
  test(`Convert then paste: ${combined ? 'same action' : 'separate actions control'}`, () => {
    const p = commandReplica(commandGenesis());
    try {
      const nodeId = p.handle(p.nodes()[0]);
      const before = p.markdown();
      let result: LocalEditResult | undefined;
      const source = '```js\ncode\n```';
      const plan = parseBlocks(source, { provenance: true }).provenance;
      if (combined) {
        result = p.editor.edit(
          session,
          (ctx) => {
            insertText(ctx, { nodeId, from: 0, to: 6, text: source });
            interpretMarkdown(ctx, nodeId, plan);
            return insertMarkdown(ctx, { contextId: nodeId, markdown: 'pasted\n\ntail' });
          },
          undefined,
        );
      } else {
        p.editor.edit(
          session,
          insertText,
          { nodeId, from: 0, to: 6, text: source },
          {
            conversion: { nodeId, plan },
          },
        );
        p.editor.edit(session, insertMarkdown, {
          contextId: p.handle(p.nodes()[0]),
          markdown: 'pasted\n\ntail',
        });
      }
      expect(p.nodes().map((n) => [n.type, n.content])).toEqual([
        ['code-block', 'code'],
        ['paragraph', 'pasted'],
        ['paragraph', 'tail'],
      ]);
      if (result) verifyReplay(p, result, before);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(cold.observe()).toEqual(p.observe());
      } finally {
        cold.close();
      }
    } finally {
      p.close();
    }
  });
}

function mergedQuotes() {
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    ...['A', 'B'].flatMap((id) => [
      { id, role: 'quote' as const, parent: 'root' },
      {
        id: `p${id}`,
        role: 'inline' as const,
        parent: id,
        flow: `f${id}`,
        run: `r${id}`,
        tape: `t${id}`,
        cells: [{ id: `${id}text`, text: id }],
      },
    ]),
  ]);
  const genesis = {
    documentId: 'D',
    genesisId: 'G',
    layout: fixture.genesis,
    body: { ...fixture.bodies.get('G')!, allocations: fixture.genesis.allocations },
  };
  return { fixture, p: commandReplica(genesis) };
}

for (const target of [0, 1]) {
  test(`Paste two paragraphs after constituent ${target} of a normalized quote`, () => {
    const { fixture, p } = mergedQuotes();
    try {
      expect(p.view().root.children[0].wrappers).toHaveLength(2);
      const before = p.markdown(),
        identities = orderedIdentities(p),
        rawParent = p.view().root.children[0].wrappers.at(-1)!.node;
      const result = p.editor.edit(session, insertMarkdown, {
        contextId: p.handle(p.nodes()[target]),
        markdown: 'one\n\ntwo',
      });
      expect(p.nodes().map((n) => n.content)).toEqual(
        target === 0 ? ['A', 'one', 'two', 'B'] : ['A', 'B', 'one', 'two'],
      );
      expect(p.view().root.children).toHaveLength(1);
      expect(p.view().root.children[0].children).toHaveLength(4);
      expect(
        p
          .nodes()
          .filter((n) => n.content === 'one' || n.content === 'two')
          .map((n) => n.edge?.slot.parent),
      ).toEqual([rawParent, rawParent]);
      expect(orderedIdentities(p).filter((id) => identities.includes(id))).toEqual(identities);
      verifyReplay(p, result, before);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(cold.observe()).toEqual(p.observe());
      } finally {
        cold.close();
      }
    } finally {
      p.close();
      fixture.destroy();
    }
  });
}

test('Paste two paragraphs into an unmerged quote control', () => {
  const p = commandReplica(commandGenesis('> A\n>\n> B'));
  try {
    expect(p.view().root.children[0].wrappers).toHaveLength(1);
    p.editor.edit(session, insertMarkdown, {
      contextId: p.handle(p.nodes()[0]),
      markdown: 'one\n\ntwo',
    });
    expect(p.nodes().map((n) => n.content)).toEqual(['A', 'one', 'two', 'B']);
  } finally {
    p.close();
  }
});

test('Paste one paragraph into a normalized quote control', () => {
  const { fixture, p } = mergedQuotes();
  try {
    p.editor.edit(session, insertMarkdown, {
      contextId: p.handle(p.nodes()[0]),
      markdown: 'one',
    });
    expect(p.nodes().map((n) => n.content)).toEqual(['A', 'one', 'B']);
  } finally {
    p.close();
    fixture.destroy();
  }
});

test('Paste, split the new paragraph, and indent its tail in one action', () => {
  const p = commandReplica(commandGenesis());
  try {
    const before = p.markdown();
    const result = p.editor.edit(
      session,
      (ctx) => {
        const paste = insertMarkdown(ctx, {
          contextId: p.handle(p.nodes()[0]),
          markdown: 'uvwxyz',
        });
        if (paste.status !== 'handled' || !paste.focus) throw new Error('Missing paste focus');
        const split = insertParagraph(ctx, { nodeId: paste.focus.nodeId, from: 3 });
        if (split.status !== 'handled' || !split.focus) throw new Error('Missing split focus');
        return indent(ctx, { nodeId: split.focus.nodeId });
      },
      undefined,
    );
    expect(p.markdown()).toBe('abcdef\n\nuvw\n* xyz\n');
    verifyReplay(p, result, before);
  } finally {
    p.close();
  }
});
