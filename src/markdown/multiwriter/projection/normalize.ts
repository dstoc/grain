import { normalizeSemanticTree } from '../../semantic/normalize.js';
import type { SemanticNormalizationDraft } from '../../semantic/draft.js';
import { resourceKey } from '../layout/index.js';
import type { MutableViewNode, ViewNode } from './types.js';
import { ProjectionError } from './interpretation.js';

/** The existing one-pass rules run only on detached records. Origins never follow view moves. */
export function normalizeProjection(root: ViewNode): ViewNode {
  const tree = structuredClone(root) as MutableViewNode;
  const nodes = new Map<string, MutableViewNode>();
  const parents = new Map<string, string>();
  const key = (node: MutableViewNode) => resourceKey(node.origin.representative);
  function register(node: MutableViewNode): void {
    const id = key(node);
    if (nodes.has(id)) throw new ProjectionError('Duplicate view identity');
    nodes.set(id, node);
    for (const child of node.children) {
      parents.set(key(child), id);
      register(child);
    }
  }
  register(tree);
  const requireNode = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new ProjectionError('Missing view node');
    return node;
  };
  const siblings = (id: string) => {
    const parent = parents.get(id);
    return parent ? requireNode(parent).children : [];
  };
  function unlink(id: string): void {
    const list = siblings(id);
    const index = list.findIndex((node) => key(node) === id);
    if (index >= 0) list.splice(index, 1);
    parents.delete(id);
  }
  const draft: SemanticNormalizationDraft = {
    node(id) {
      const node = requireNode(id);
      return {
        id,
        type: node.type,
        marker: node.marker,
        checked: node.checked,
        children: node.children.map(key),
      };
    },
    parentOf: (id) => parents.get(id),
    previousSiblingOf(id) {
      const list = siblings(id);
      const i = list.findIndex((node) => key(node) === id);
      return i > 0 ? key(list[i - 1]!) : undefined;
    },
    nextSiblingOf(id) {
      const list = siblings(id);
      const i = list.findIndex((node) => key(node) === id);
      return i >= 0 && i + 1 < list.length ? key(list[i + 1]!) : undefined;
    },
    create() {
      throw new ProjectionError('Normalization cannot allocate a projection node');
    },
    place(id, parent, before) {
      if (id === before && parents.get(id) === parent) return;
      const node = requireNode(id);
      const target = requireNode(parent);
      unlink(id);
      const index =
        before === null
          ? target.children.length
          : target.children.findIndex((child) => key(child) === before);
      if (index < 0) throw new ProjectionError('Missing normalization destination');
      target.children.splice(index, 0, node);
      parents.set(id, parent);
    },
    detach(id) {
      const node = requireNode(id);
      const previousId = draft.previousSiblingOf(id);
      const previous = previousId ? requireNode(previousId) : undefined;
      // mergeAdjacent empties the later wrapper before detaching it. Cleanup cannot
      // encounter adjacent equal wrappers: the forward merge has already consumed them.
      if (
        previous &&
        previous.type === node.type &&
        (node.type === 'list' || node.type === 'block-quote')
      ) {
        previous.origin.constituents.push(...node.origin.constituents);
        previous.wrappers.push(...node.wrappers);
      }
      unlink(id);
    },
    setMarker(id, marker) {
      requireNode(id).marker = marker;
    },
    setChecked(id, checked) {
      requireNode(id).checked = checked;
    },
  };
  normalizeSemanticTree(draft, key(tree), { createEmptyRoot: false });
  return tree;
}
