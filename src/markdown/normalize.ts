import type { MarkdownTree } from './view-model.js';
import { MarkdownTreeDraft } from './semantic-tree-draft.js';
import { normalizeSemanticTree, type SemanticNormalizeOptions } from './semantic/normalize.js';

export interface NormalizeTreeOptions extends SemanticNormalizeOptions {
  readonly force?: boolean;
}

/** Apply the shared one-pass normalizer to a mutable MarkdownTree. */
export function normalizeTree(tree: MarkdownTree, options: NormalizeTreeOptions = {}): void {
  const draft = new MarkdownTreeDraft(tree);
  normalizeSemanticTree(draft, draft.rootId, options);
}
