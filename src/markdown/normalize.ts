import type { MarkdownNode } from './node.js';
import type { ViewModelNode } from './view-model-node.js';
import { viewModel } from './view-model-node.js';
import type { MarkdownTree } from './view-model.js';
import {
  normalizeSemanticTree,
  type SemanticDraftNode,
  type SemanticNodeId,
  type SemanticNodeKind,
  type SemanticNormalizeOptions,
  type SemanticNormalizationDraft,
} from './semantic-normalize.js';

export interface NormalizeTreeOptions extends SemanticNormalizeOptions {
  readonly force?: boolean;
}

function nodeFromSpec(spec: {
  readonly type: SemanticNodeKind;
  readonly content?: string;
}): MarkdownNode {
  switch (spec.type) {
    case 'paragraph':
      return { type: 'paragraph', content: spec.content ?? '' };
    case 'section':
      return { type: 'section', marker: '#', content: spec.content ?? '' };
    case 'code-block':
      return { type: 'code-block', info: null, content: spec.content ?? '' };
    case 'list':
      return { type: 'list' };
    case 'list-item':
      return { type: 'list-item', marker: '- ' };
    case 'block-quote':
      return { type: 'block-quote', marker: '> ' };
    case 'document':
      throw new Error('normalization cannot create another document root');
  }
}

function markdownTreeDraft(tree: MarkdownTree): {
  readonly rootId: SemanticNodeId;
  readonly draft: SemanticNormalizationDraft;
} {
  const ids = new WeakMap<object, SemanticNodeId>();
  const nodes = new Map<SemanticNodeId, ViewModelNode>();
  let ordinal = 0;
  const idOf = (node: ViewModelNode): SemanticNodeId => {
    let id = ids.get(node);
    if (!id) {
      id = `markdown-node:${ordinal++}`;
      ids.set(node, id);
      nodes.set(id, node);
    }
    return id;
  };
  const get = (id: SemanticNodeId): ViewModelNode => {
    const node = nodes.get(id);
    if (!node) throw new Error(`normalization references unknown node ${id}`);
    return node;
  };
  const rootId = idOf(tree.root);
  const draft: SemanticNormalizationDraft = {
    node(id): SemanticDraftNode {
      const node = get(id);
      return {
        id,
        type: node.type,
        children: (node.children ?? []).map((child) => idOf(child as ViewModelNode)),
        marker: 'marker' in node ? node.marker : null,
        checked: node.type === 'list-item' ? (node.checked ?? null) : null,
      };
    },
    parentOf(id) {
      const parent = get(id)[viewModel].parent;
      return parent ? idOf(parent) : undefined;
    },
    previousSiblingOf(id) {
      const previous = get(id)[viewModel].previousSibling;
      return previous ? idOf(previous) : undefined;
    },
    nextSiblingOf(id) {
      const next = get(id)[viewModel].nextSibling;
      return next ? idOf(next) : undefined;
    },
    create(spec) {
      return idOf(tree.add(nodeFromSpec(spec)));
    },
    place(id, parent, before) {
      get(id)[viewModel].insertBefore(get(parent), before === null ? undefined : get(before));
    },
    detach(id) {
      get(id)[viewModel].remove();
    },
    setMarker(id, marker) {
      if (marker === null) throw new Error('Markdown section and list-item markers cannot be null');
      get(id)[viewModel].updateMarker(marker);
    },
    setChecked(id, checked) {
      get(id)[viewModel].updateChecked(checked ?? undefined);
    },
  };
  return { rootId, draft };
}

/** Apply the shared one-pass normalizer to a mutable MarkdownTree. */
export function normalizeTree(tree: MarkdownTree, options: NormalizeTreeOptions = {}): void {
  const { rootId, draft } = markdownTreeDraft(tree);
  normalizeSemanticTree(draft, rootId, options);
}
