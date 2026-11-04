import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { indent } from '../../../editing/commands/indent.js';
import { outdent } from '../../../editing/commands/outdent.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
const session = { local: 'scope', group: 1n };
test('a scoped list command cannot outdent content outside its declared scope', () => {
  const p = commandReplica(commandGenesis('- first\n- second'));
  try {
    const list = p.view().root.children[0]!,
      before = p.document.store.encodeUpdate();
    const result = p.editor.edit(
      session,
      outdent,
      { nodeId: p.handle(p.nodes()[1]!) },
      { scopeRoot: p.handle(list) },
    );
    expect(result.status).toBe('not-applicable');
    expect(p.document.store.encodeUpdate()).toEqual(before);
  } finally {
    p.close();
  }
});
test('selection and caret origins survive indent as stable addresses', () => {
  const p = commandReplica(commandGenesis('text'));
  try {
    const nodeId = p.handle(p.nodes()[0]!),
      selection = {
        anchor: { nodeId, offset: 1, affinity: 'left' as const },
        focus: { nodeId, offset: 3, affinity: 'right' as const },
      };
    const result = p.editor.edit(session, indent, { nodeId }, { selectionBefore: selection });
    if (result.status !== 'applied') throw new Error('Expected indent');
    expect(result.selectionBefore?.anchor.native).toBeDefined();
    expect(result.selectionBefore?.focus.native).toBeDefined();
    expect(result.focus?.native).toBeDefined();
    expect(p.markdown()).toBe('* text\n');
  } finally {
    p.close();
  }
});
test('an inapplicable command that mutated its isolated draft authors no facts', () => {
  const p = commandReplica(commandGenesis());
  try {
    const bytes = p.document.store.encodeUpdate(),
      client = p.editor.nativeClientId;
    expect(() =>
      p.editor.edit(
        session,
        ({ draft }) => {
          draft.create({ type: 'paragraph', content: 'orphan' });
          return { status: 'not-applicable' };
        },
        undefined,
      ),
    ).toThrow(/mutated/);
    expect(p.document.store.encodeUpdate()).toEqual(bytes);
    expect(p.editor.nativeClientId).toBe(client);
  } finally {
    p.close();
  }
});
test('empty-root input creates one real paragraph/home and input in one action; reads author nothing', () => {
  const f = new NativeFixture(),
    genesis = {
      documentId: 'D',
      genesisId: 'G',
      layout: f.genesis,
      body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    },
    p = commandReplica(genesis);
  try {
    f.author('B1', (f) => [f.deleteSubtree('P', f.contentRanges.get('P')!, [])]);
    p.receive(
      (() => {
        const remote = commandReplica(genesis);
        try {
          remote.document.store.append(f.envelope('B1'));
          return remote.document.store.encodeUpdate();
        } finally {
          remote.close();
        }
      })(),
    );
    expect(p.view().emptyRoot).not.toBeNull();
    const bytes = p.document.store.encodeUpdate(),
      native = p.observe().native;
    expect(p.markdown()).toBe('');
    p.view();
    expect(p.document.store.encodeUpdate()).toEqual(bytes);
    expect(p.observe().native).toEqual(native);
    expect(() => p.editor.editEmptyRoot(session, '')).toThrow();
    expect(p.document.store.encodeUpdate()).toEqual(bytes);
    const result = p.editor.editEmptyRoot(session, 'typed');
    expect(result.status).toBe('applied');
    expect(p.markdown()).toBe('typed\n');
    if (result.status !== 'applied') throw new Error('Missing empty-root action');
    expect(result.envelope.allocations.filter((a) => a.type === 'flow')).toHaveLength(1);
  } finally {
    p.close();
    f.destroy();
  }
});
test('Markdown replacement preserves task marker/state and the in-scope item', () => {
  const p = commandReplica(commandGenesis('- [x] '));
  try {
    const item = p.view().root.children[0]!.children[0]!,
      nodeId = p.handle(p.nodes()[0]!);
    p.editor.edit(
      session,
      insertMarkdown,
      { contextId: nodeId, markdown: 'pasted', replaceActiveEmptyTarget: true },
      { scopeRoot: p.handle(item) },
    );
    expect(p.markdown()).toBe('- [x] pasted\n');
    expect(p.view().root.children[0]!.children[0]!.origin.representative).toEqual(
      item.origin.representative,
    );
    p.editor.edit(session, insertText, { nodeId: p.handle(p.nodes()[0]!), from: 6, text: '!' });
    expect(p.markdown()).toBe('- [x] pasted!\n');
  } finally {
    p.close();
  }
});
