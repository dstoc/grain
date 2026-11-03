import { expect, it } from 'vitest';

import type { DraftNode, TreeDraft } from '../../markdown/semantic/draft.js';
import type { NodeId, NodeKind } from '../../markdown/semantic/types.js';
import { previousInline } from './inline.js';

it('finds the adjacent inline through the preceding subtree without walking the scope', () => {
  const nodes = new Map<NodeId, DraftNode>();
  const parents = new Map<NodeId, NodeId>();
  const previous = new Map<NodeId, NodeId | undefined>();

  function add(id: NodeId, type: NodeKind, children: readonly NodeId[] = [], parent?: NodeId) {
    const node = {
      id,
      type,
      children,
      marker: null,
      checked: null,
      info: null,
      ...(type === 'paragraph' || type === 'section' || type === 'code-block'
        ? { content: '' }
        : {}),
    } as DraftNode;
    nodes.set(id, node);
    if (parent) parents.set(id, parent);
    children.forEach((child, index) => {
      previous.set(child, index ? children[index - 1] : undefined);
    });
  }

  add('root', 'document', ['before', 'list', 'far-1', 'far-2', 'far-3']);
  add('before', 'paragraph', [], 'root');
  add('list', 'list', ['item-a', 'item-b'], 'root');
  add('item-a', 'list-item', ['first', 'nested'], 'list');
  add('first', 'paragraph', [], 'item-a');
  add('nested', 'list', ['nested-item'], 'item-a');
  add('nested-item', 'list-item', ['previous'], 'nested');
  add('previous', 'code-block', [], 'nested-item');
  add('item-b', 'list-item', ['current'], 'list');
  add('current', 'paragraph', [], 'item-b');
  add('far-1', 'paragraph', [], 'root');
  add('far-2', 'paragraph', [], 'root');
  add('far-3', 'paragraph', [], 'root');

  let nodeReads = 0;
  const draft = {
    node(id: NodeId) {
      nodeReads++;
      const node = nodes.get(id);
      if (!node) throw new Error(`missing node ${id}`);
      return node;
    },
    parentOf(id: NodeId) {
      return parents.get(id);
    },
    previousSiblingOf(id: NodeId) {
      return previous.get(id);
    },
  } as unknown as TreeDraft;

  expect(previousInline(draft, 'root', 'current')).toBe('previous');
  expect(nodeReads).toBeLessThan(8);
});
