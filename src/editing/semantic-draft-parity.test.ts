import { afterEach, describe, expect, it } from 'vitest';

import type { ActionRequest } from '../markdown/canonical-actions.js';
import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument, type NodeId } from '../markdown/canonical-model.js';
import { parseBlocks } from '../markdown/block-parser/api.js';
import { serializeToString } from '../markdown/block-serializer.js';
import { MarkdownTreeDraft } from '../markdown/semantic-tree-draft.js';
import { MarkdownTree } from '../markdown/view-model.js';
import type { ViewModelNode } from '../markdown/view-model-node.js';
import type { EditContext } from './context.js';
import type { EditOutcome } from './outcomes.js';
import { deleteBackwardAtStart } from './commands/delete-backward.js';
import { indent } from './commands/indent.js';
import { insertLineBreak } from './commands/insert-line-break.js';
import { insertParagraph } from './commands/insert-paragraph.js';
import { replaceBlocks } from './commands/replace-blocks.js';
import { wrap } from './commands/wrap.js';

type SharedEdit = (context: EditContext, nodeId: NodeId) => EditOutcome;

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
    const outcome = edit({ draft, scopeRoot: draft.rootId }, draft.idOf(node));
    if (outcome.status === 'not-applicable')
      throw new Error('construction edit was not applicable');
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
    edit: (context, nodeId) => insertParagraph(context, { nodeId, from: 5 }),
  },
  {
    name: 'indent a list item',
    markdown: '* alpha\n* beta\n',
    path: [0, 1, 0],
    edit: (context, nodeId) => indent(context, { nodeId }),
  },
  {
    name: 'wrap an inline node',
    markdown: 'alpha\n',
    path: [0],
    edit: (context, nodeId) => wrap(context, { nodeId, wrapper: 'block-quote' }),
  },
  {
    name: 'replace selected block text',
    markdown: 'first\n\nsecond\n',
    path: [1],
    edit: (context, nodeId) => replaceBlocks(context, { nodeIds: [nodeId], text: 'replacement' }),
  },
  {
    name: 'split a code block',
    markdown: '```js\nabcd\n```\n',
    path: [0],
    edit: (context, nodeId) => insertLineBreak(context, { nodeId, from: 2 }),
  },
  {
    name: 'convert a section to a paragraph',
    markdown: '# heading\nbody\n',
    path: [0],
    edit: (context, nodeId) => deleteBackwardAtStart(context, { nodeId }),
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
    writer.admitSession('local');
    const request: ActionRequest = writer.prepareCommand(
      { actionId: `edit-${ordinal}` },
      (draft) => {
        const outcome = fixture.edit(
          { draft, scopeRoot: canonical.root.sharedId },
          canonicalTarget.sharedId,
        );
        if (outcome.status === 'not-applicable') return;
        return outcome.focus
          ? {
              end: draft.bookmark(
                outcome.focus.nodeId,
                outcome.focus.offset,
                outcome.focus.affinity,
              ),
            }
          : undefined;
      },
    );
    const applied = writer.apply(request, {
      sessionId: 'local',
      authorityEpoch: request.authorityEpoch,
      sessionSequence: request.sessionSequence,
    });
    expect(applied.status).toBe('pending');
    if (applied.status !== 'pending')
      throw new Error(`canonical command failed: ${applied.status}`);
    writer.publish(applied.pending);
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
