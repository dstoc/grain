import { afterEach, describe, expect, it } from 'vitest';

import { CanonicalWriter } from '../canonical-actions.js';
import { CanonicalDocument } from '../canonical-model.js';
import { parseBlocks } from '../block-parser/api.js';
import { MarkdownTreeDraft } from '../semantic-tree-draft.js';
import { MarkdownTree } from '../view-model.js';
import type { TreeDraft, InlineFragment } from './draft.js';
import type { CreateNodeSpec, NodeId } from './types.js';

it('keeps canonical span hints out of neutral draft edits', () => {
  const spliceText: TreeDraft['spliceText'] = () => {};
  // @ts-expect-error Canonical storage hints are not part of semantic text edits.
  spliceText('node', { from: 0, to: 0, insert: 'x', spanIndex: 0 });
});

interface DraftHarness {
  readonly rootId: NodeId;
  run(callback: (draft: TreeDraft) => void): void;
  close(): void;
}

let documentSequence = 0;

function canonicalHarness(source: string): DraftHarness {
  const document = CanonicalDocument.fromMarkdown(source, {
    documentId: `semantic-contract-${++documentSequence}`,
    actionId: 'import',
  });
  const writer = new CanonicalWriter(document);
  let sequence = 0;
  return {
    rootId: document.root.sharedId,
    run(callback) {
      writer.prepareCommand({ actionId: `semantic-contract-${++sequence}` }, callback);
    },
    close() {
      writer.close();
      document.close();
    },
  };
}

function constructionHarness(source: string): DraftHarness {
  const tree = new MarkdownTree(parseBlocks(source).node);
  const initialDraft = new MarkdownTreeDraft(tree);
  const rootId = initialDraft.rootId;
  return {
    rootId,
    run(callback) {
      tree.edit(() => {
        callback(new MarkdownTreeDraft(tree));
        return {};
      });
    },
    close() {},
  };
}

const harnesses = [
  ['canonical', canonicalHarness],
  ['construction', constructionHarness],
] as const;

const opened: DraftHarness[] = [];

afterEach(() => {
  for (const harness of opened.splice(0)) harness.close();
});

for (const [name, createHarness] of harnesses) {
  describe(`${name} semantic draft contract`, () => {
    it('keeps node views live and previously returned child arrays immutable', () => {
      const harness = createHarness('a\n\nb');
      opened.push(harness);
      harness.run((draft) => {
        const root = draft.node(harness.rootId);
        const [firstId, secondId] = root.children;
        const originalChildren = [firstId!, secondId!];
        const snapshot = root.children;
        const first = draft.node(firstId!);
        expect('spans' in first).toBe(false);

        draft.spliceText(firstId!, { from: 1, to: 1, insert: 'x' });
        draft.place(secondId!, harness.rootId, firstId!);

        expect(first.content).toBe('ax');
        expect(root.children).toEqual([secondId, firstId]);
        expect(snapshot).toEqual(originalChildren);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(() => (snapshot as NodeId[]).push('unexpected')).toThrow();
      });
    });

    it('uses strict detach and rejects text ranges that split UTF-16 characters', () => {
      const harness = createHarness('😀');
      opened.push(harness);
      harness.run((draft) => {
        const firstId = draft.node(harness.rootId).children[0]!;
        expect(() => draft.spliceText(firstId, { from: 1, to: 1, insert: 'x' })).toThrow(
          'splits a surrogate pair',
        );
        expect(() => draft.spliceText(firstId, { from: 0, to: 0, insert: '\ud800' })).toThrow(
          'unpaired high surrogate',
        );
        expect(() => draft.bookmark(firstId, 1, 'right')).toThrow('splits a surrogate pair');

        draft.detach(firstId);
        expect(() => draft.detach(firstId)).toThrow('already detached');
        expect(() => draft.detach(harness.rootId)).toThrow('document root cannot be detached');
      });
    });

    it('rejects root and child-bearing create specifications at runtime', () => {
      const harness = createHarness('a');
      opened.push(harness);
      harness.run((draft) => {
        expect(() => draft.create({ type: 'document' } as unknown as CreateNodeSpec)).toThrow(
          'another',
        );
        expect(() =>
          draft.create({ type: 'list', children: ['semantic-child'] } as unknown as CreateNodeSpec),
        ).toThrow('create nodes without children');
      });
    });

    it('moves a same-node range using the pre-transfer destination coordinate', () => {
      const harness = createHarness('abcdef');
      opened.push(harness);
      harness.run((draft) => {
        const firstId = draft.node(harness.rootId).children[0]!;
        draft.transferInlineRange({
          source: firstId,
          from: 1,
          to: 3,
          destination: firstId,
          at: 5,
          affinity: 'right',
        });
        expect(draft.node(firstId).content).toBe('adebcf');
      });

      const invalid = createHarness('abcdef');
      opened.push(invalid);
      invalid.run((draft) => {
        const firstId = draft.node(invalid.rootId).children[0]!;
        expect(() =>
          draft.transferInlineRange({
            source: firstId,
            from: 1,
            to: 4,
            destination: firstId,
            at: 2,
            affinity: 'right',
          }),
        ).toThrow('cannot be inside the transferred range');
        expect(draft.node(firstId).content).toBe('abcdef');
      });
    });

    it('keeps fragments draft local and move only', () => {
      const harness = createHarness('abcd\n\nef');
      opened.push(harness);
      let fragment: InlineFragment | undefined;
      harness.run((draft) => {
        const firstId = draft.node(harness.rootId).children[0]!;
        fragment = draft.cutInline(firstId, 1, 3);
      });
      expect(fragment?.text).toBe('bc');

      harness.run((draft) => {
        const secondId = draft.node(harness.rootId).children[1]!;
        expect(() => draft.insertFragment(secondId, 1, 'right', fragment!)).toThrow();
      });

      const oneDraft = createHarness('abcd\n\nef');
      opened.push(oneDraft);
      oneDraft.run((draft) => {
        const [firstId, secondId] = draft.node(oneDraft.rootId).children;
        const moved = draft.cutInline(firstId!, 1, 3);
        draft.insertFragment(secondId!, 1, 'right', moved);
        expect(draft.node(secondId!).content).toBe('ebcf');
        expect(() => draft.insertFragment(secondId!, 1, 'right', moved)).toThrow();
      });
    });
  });
}

describe('canonical semantic draft read tracking', () => {
  const documents: CanonicalDocument[] = [];
  const writers: CanonicalWriter[] = [];

  afterEach(() => {
    for (const writer of writers.splice(0)) writer.close();
    for (const document of documents.splice(0)) document.close();
  });

  it('records fields and tape dependencies only when their live properties are read', () => {
    const document = CanonicalDocument.fromMarkdown('text', {
      documentId: 'semantic-read-tracking',
      actionId: 'semantic-read-import',
    });
    const writer = new CanonicalWriter(document);
    documents.push(document);
    writers.push(writer);
    const id = document.root.children[0]!.sharedId;

    const identityOnly = writer.prepareCommand({ actionId: 'identity-only' }, (draft) => {
      expect(draft.node(id).id).toBe(id);
    });
    expect(identityOnly.preconditions).toEqual([]);

    const kindOnly = writer.prepareCommand({ actionId: 'kind-only' }, (draft) => {
      expect(draft.node(id).type).toBe('paragraph');
    });
    expect(kindOnly.preconditions.map((item) => item.kind === 'cell' && item.field)).toEqual([
      'kind',
    ]);

    const childrenOnly = writer.prepareCommand({ actionId: 'children-only' }, (draft) => {
      expect(draft.node(document.root.sharedId).children).toEqual([id]);
    });
    expect(childrenOnly.preconditions).toMatchObject([
      { kind: 'cell', nodeId: document.root.sharedId, field: 'children' },
    ]);

    const content = writer.prepareCommand({ actionId: 'content' }, (draft) => {
      expect(draft.node(id).content).toBe('text');
    });
    expect(content.preconditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'cell', nodeId: id, field: 'kind' }),
        expect.objectContaining({ kind: 'cell', nodeId: id, field: 'spans' }),
        expect.objectContaining({ kind: 'tape' }),
      ]),
    );
  });
});
