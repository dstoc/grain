import { expect, test } from 'vitest';
import { createGenesis } from '../bootstrap/index.js';
import { insertText, insertParagraph, wrap } from '../authoring/index.js';
import { openReplica } from './index.js';
import { ReplicaRenderTree } from './render.js';

async function replica(source: string) {
  const genesis = createGenesis('renderer', source);
  return openReplica({
    genesis,
    persistedGenesis: genesis,
    mode: 'disconnected',
    journal: { read: async () => [], append: async () => {}, close() {} },
  });
}
test('renderer keeps unaffected identity, signals and inline trees through distant text and split', async () => {
  const r = await replica('first\n\nsecond'),
    tree = new ReplicaRenderTree();
  try {
    const root = tree.refresh(r.publication().value.view),
      second = root.children[1];
    const version = second.version,
      signal = second.renderSignal.value,
      inline = second.inlineTree;
    const first = r.publication().value.view.root.children[0];
    r.edit(insertText, { nodeId: r.handle(first.origin.representative), from: 0, text: 'X' });
    expect(tree.refresh(r.publication().value.view)).toBe(root);
    expect(root.children[1]).toBe(second);
    expect(second.version).toBe(version);
    r.edit(insertParagraph, { nodeId: r.handle(first.origin.representative), from: 2 });
    tree.refresh(r.publication().value.view);
    expect(root.children[2]).toBe(second);
    expect(second.version).toBe(version);
    expect(second.renderSignal.value).toBe(signal);
    expect(second.inlineTree).toBe(inline);
    expect(second.previousSibling).toBe(root.children[1]);
    expect(second.parent).toBe(root);
  } finally {
    await r.close();
  }
});
test('normalized wrappers resolve every constituent to the current representative facade', async () => {
  const r = await replica('first\n\nsecond'),
    tree = new ReplicaRenderTree();
  try {
    const first = r.publication().value.view.root.children[0].origin.representative,
      second = r.publication().value.view.root.children[1].origin.representative;
    r.edit(wrap, { nodeId: r.handle(first), wrapper: 'block-quote' });
    const root = tree.refresh(r.publication().value.view),
      quote = root.children[0];
    r.edit(wrap, { nodeId: r.handle(second), wrapper: 'block-quote' });
    tree.refresh(r.publication().value.view);
    const normalized = root.children[0];
    expect(normalized).toBe(quote);
    expect(normalized.children.map((n) => n.content)).toEqual(['first', 'second']);
    expect(normalized.projection!.origin.constituents).toHaveLength(2);
    for (const id of normalized.projection!.origin.constituents)
      expect(tree.node(id)).toBe(normalized);
    const independent = new ReplicaRenderTree();
    independent.refresh(r.publication().value.view);
    expect(independent.owns(normalized)).toBe(false);
    expect(tree.owns(normalized)).toBe(true);
  } finally {
    await r.close();
  }
});
test('empty-root caret remains local and disconnects when the first edit creates a real paragraph', async () => {
  const r = await replica('old'),
    tree = new ReplicaRenderTree();
  try {
    const old = tree.refresh(r.publication().value.view).children[0];
    r.edit(({ draft }, id: string) => {
      draft.deleteSubtree(id);
      return { status: 'handled' };
    }, r.handle(old.projection!.origin.representative));
    const held = r.retainedUpdate();
    const root = tree.refresh(r.publication().value.view);
    expect(root.children).toEqual([tree.emptyCaret]);
    expect(tree.emptyCaret.projection).toBeUndefined();
    expect(old.connected).toBe(false);
    expect(old.parent).toBeUndefined();
    expect(r.retainedUpdate()).toEqual(held);
    r.editEmptyRoot('new');
    tree.refresh(r.publication().value.view);
    expect(tree.emptyCaret.connected).toBe(false);
    expect(root.children[0].content).toBe('new');
    expect(root.children[0]).not.toBe(tree.emptyCaret);
  } finally {
    await r.close();
  }
});
