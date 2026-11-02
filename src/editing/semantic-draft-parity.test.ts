import { afterEach, describe, expect, it } from 'vitest';

import type { TreeDraft } from '../markdown/canonical-actions.js';
import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument, type NodeId } from '../markdown/canonical-model.js';
import { parseBlocks } from '../markdown/block-parser/api.js';
import { serializeToString } from '../markdown/block-serializer.js';
import { MarkdownTreeDraft } from '../markdown/semantic-tree-draft.js';
import { MarkdownTree } from '../markdown/view-model.js';
import type { ViewModelNode } from '../markdown/view-model-node.js';
import {
  deleteContentBackwards,
  editIndent,
  insertLineBreak,
  insertParagraph,
  replaceSelectedBlocks,
  wrapInline,
} from './canonical-edits.js';

type SharedEdit = (draft: TreeDraft, root: NodeId, node: NodeId) => void;

interface ParityCase {
  readonly name: string;
  readonly markdown: string;
  readonly path: readonly number[];
  readonly edit: SharedEdit;
}

let ordinal = 0;
const openDocuments: { readonly document: CanonicalDocument; readonly writer: CanonicalWriter }[] =
  [];

afterEach(() => {
  for (const { writer, document } of openDocuments.splice(0)) {
    writer.close();
    document.close();
  }
});

function atPath<T extends { readonly children: readonly T[] }>(
  root: T,
  path: readonly number[],
): T {
  let node = root;
  for (const index of path) node = node.children[index]!;
  return node;
}

function nodeAtPath(root: ViewModelNode, path: readonly number[]): ViewModelNode {
  let node = root;
  for (const index of path) node = node.children![index] as ViewModelNode;
  return node;
}

function markdown(document: CanonicalDocument): string {
  return serializeToString(document.exportMarkdownTree());
}

function runTreeEdit(tree: MarkdownTree, node: ViewModelNode, edit: SharedEdit): void {
  tree.edit(() => {
    const draft = new MarkdownTreeDraft(tree);
    edit(draft, draft.rootId, draft.idOf(node));
    return {};
  });
}

function serializedTree(tree: MarkdownTree): string {
  return serializeToString(tree.serialize());
}

const cases: readonly ParityCase[] = [
  {
    name: 'split a paragraph',
    markdown: 'alpha beta\n',
    path: [0],
    edit: (draft, root, node) => void insertParagraph(draft, root, node, 5),
  },
  {
    name: 'indent a list item',
    markdown: '* alpha\n* beta\n',
    path: [0, 1, 0],
    edit: (draft, root, node) => void editIndent(draft, root, node, 'indent'),
  },
  {
    name: 'wrap an inline node',
    markdown: 'alpha\n',
    path: [0],
    edit: (draft, root, node) => void wrapInline(draft, root, node, 'block-quote'),
  },
  {
    name: 'replace selected block text',
    markdown: 'first\n\nsecond\n',
    path: [1],
    edit: (draft, root, node) => void replaceSelectedBlocks(draft, root, [node], 'replacement'),
  },
  {
    name: 'split a code block',
    markdown: '```js\nabcd\n```\n',
    path: [0],
    edit: (draft, root, node) => void insertLineBreak(draft, root, node, 2),
  },
  {
    name: 'convert a section to a paragraph',
    markdown: '# heading\nbody\n',
    path: [0],
    edit: (draft, root, node) => void deleteContentBackwards(draft, root, node),
  },
];

describe('shared semantic editing draft', () => {
  it.each(cases)('$name has the same tree and history on each draft backend', (fixture) => {
    const canonical = CanonicalDocument.fromMarkdown(fixture.markdown, {
      documentId: `semantic-draft-parity-${++ordinal}`,
      actionId: `semantic-draft-import-${ordinal}`,
    });
    const writer = new CanonicalWriter(canonical);
    openDocuments.push({ document: canonical, writer });

    const tree = new MarkdownTree(parseBlocks(fixture.markdown).node);
    const canonicalTarget = atPath(canonical.root, fixture.path);
    const treeTarget = nodeAtPath(tree.root, fixture.path);
    const before = markdown(canonical);
    const canonicalEdit = writer.edit({ actionId: `edit-${ordinal}` }, (draft) =>
      fixture.edit(draft, canonical.root.sharedId, canonicalTarget.sharedId),
    );
    expect(canonicalEdit).toHaveProperty('receipt');
    runTreeEdit(tree, treeTarget, fixture.edit);

    expect(serializedTree(tree)).toBe(markdown(canonical));
    expect(tree.undo(tree.root)).toBeDefined();
    expect(writer.undo()).toHaveProperty('status', 'applied');
    expect(serializedTree(tree)).toBe(before);
    expect(markdown(canonical)).toBe(before);

    expect(tree.redo(tree.root)).toBeDefined();
    expect(writer.redo()).toHaveProperty('status', 'applied');
    expect(serializedTree(tree)).toBe(markdown(canonical));
  });
});
