import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { CanonicalDocument } from './canonical-model.js';
import type { CanonicalCheckpoint } from './canonical-model.js';
import type { DocumentNode } from './node.js';
import { viewModel } from './view-model-node.js';

function applyToAuthority(
  checkpoint: CanonicalCheckpoint,
  revision: number,
  edit: (document: Y.Doc) => void,
): { readonly authority: Y.Doc; readonly update: Uint8Array } {
  const authority = new Y.Doc({ gc: false });
  Y.applyUpdate(authority, checkpoint.update);
  edit(authority);
  authority.getMap('meta').set('acceptedRevision', revision);
  return { authority, update: Uint8Array.from(Y.encodeStateAsUpdate(authority)) };
}

function nodeRecord(document: Y.Doc, id: string): Y.Map<unknown> {
  const record = document.getMap('nodes').get(id);
  if (!(record instanceof Y.Map)) throw new Error(`missing node ${id}`);
  return record as Y.Map<unknown>;
}

function cellValue<T>(record: Y.Map<unknown>, field: string): T {
  const cell = record.get(field) as { value: T } | undefined;
  if (!cell) throw new Error(`missing cell ${field}`);
  return cell.value;
}

function setCell(record: Y.Map<unknown>, field: string, token: string, value: unknown) {
  record.set(field, { token, value });
}

function replaceCheckpointState(
  checkpoint: CanonicalCheckpoint,
  field: 'schemaVersion' | 'normalizationVersion',
  value: number,
): CanonicalCheckpoint {
  const source = new Y.Doc({ gc: false });
  Y.applyUpdate(source, checkpoint.update);
  source.getMap('meta').set(field, value);
  return Object.freeze({
    ...checkpoint,
    [field]: value,
    update: Uint8Array.from(Y.encodeStateAsUpdate(source)),
  });
}

describe('CanonicalDocument', () => {
  it('reconstructs canonical fields without state writes during read projection', () => {
    const original = CanonicalDocument.fromMarkdown('# Heading\n\nText\n\n```ts\ncode\n```', {
      documentId: 'reconstruct-doc',
      actionId: 'import-1',
      authorityEpoch: 'epoch-1',
    });
    const expected = original.canonicalSnapshot();
    const stableIds = [
      ...expected.nodes.map((node) => node.id),
      ...expected.tapes.map((tape) => tape.id),
      ...expected.nodes.flatMap((node) =>
        node.spans.flatMap((span) => [span.startBoundaryId, span.endBoundaryId]),
      ),
    ];
    expect(new Set(stableIds).size).toBe(stableIds.length);
    for (const tape of expected.tapes) {
      expect(original.tapeRevision(tape.id)).toBe(0);
      expect(typeof tape.delta[0]).toBe('object');
      expect(typeof tape.delta.at(-1)).toBe('object');
    }
    const reopened = CanonicalDocument.open(original.checkpoint());
    const beforeReads = reopened.checkpoint().update;

    expect(reopened.canonicalSnapshot()).toEqual(expected);
    expect(reopened.exportMarkdownTree()).toEqual(original.exportMarkdownTree());
    expect(reopened.validateRetainedForest()).toEqual({ valid: true, errors: [] });
    expect(reopened.validateActiveSpans()).toEqual({ valid: true, errors: [] });
    expect(reopened.checkpoint().update).toEqual(beforeReads);
  });

  it('separates parser imports from one-pass tree construction normalization', () => {
    const tree: DocumentNode = {
      type: 'document',
      children: [
        { type: 'paragraph', content: 'before' },
        { type: 'section', marker: '#', content: 'heading', children: [] },
        { type: 'paragraph', content: 'inside' },
      ],
    };
    const parsed = CanonicalDocument.fromParsed(tree, {
      documentId: 'parsed-tree-doc',
      actionId: 'parsed-tree',
    });
    const constructed = CanonicalDocument.fromTree(tree, {
      documentId: 'constructed-tree-doc',
      actionId: 'constructed-tree',
    });
    const reopened = CanonicalDocument.open(parsed.checkpoint());

    expect(parsed.exportMarkdownTree().children).toHaveLength(3);
    expect(reopened.exportMarkdownTree()).toEqual(parsed.exportMarkdownTree());
    expect(constructed.exportMarkdownTree().children).toHaveLength(2);
    expect(constructed.exportMarkdownTree().children![1]!.children).toHaveLength(1);
  });

  it('defends stored cells and read views from caller mutation', () => {
    const source: DocumentNode = {
      type: 'document',
      children: [{ type: 'paragraph', content: 'kept' }],
    };
    const document = CanonicalDocument.fromParsed(source, {
      documentId: 'immutable-doc',
      actionId: 'immutable',
    });
    const paragraph = document.root.children[0]!;
    const originalSnapshot = document.canonicalSnapshot();

    const sourceParagraph = source.children![0] as { type: string; content: string };
    sourceParagraph.type = 'code-block';
    sourceParagraph.content = 'changed';
    expect(paragraph.content).toBe('kept');
    expect(() => (originalSnapshot.nodes[0]!.children as string[]).push('forged')).toThrow();
    expect(document.canonicalSnapshot()).toEqual(originalSnapshot);
  });

  it('reuses deterministic document-scoped IDs when an import is retried', () => {
    const tree: DocumentNode = {
      type: 'document',
      children: [{ type: 'paragraph', content: 'retry' }],
    };
    const options = { documentId: 'retry-doc', actionId: 'retry-action' };
    const first = CanonicalDocument.fromParsed(tree, options);
    const retried = CanonicalDocument.fromParsed(tree, options);

    expect(retried.canonicalSnapshot()).toEqual(first.canonicalSnapshot());
  });

  it('lazily caches inline parse trees and refreshes them after accepted text changes', () => {
    const document = CanonicalDocument.fromParsed(
      { type: 'document', children: [{ type: 'paragraph', content: 'before' }] },
      {
        documentId: 'inline-cache-doc',
        actionId: 'inline-cache',
        authorityEpoch: 'inline-cache-epoch',
      },
    );
    const paragraph = document.root.children[0]!;
    const firstTree = paragraph.inlineTree;
    const span = document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)!
      .spans[0]!;
    const update = applyToAuthority(document.checkpoint(), 1, (authority) => {
      const tape = authority.getMap('tapes').get(span.tapeId) as Y.Text;
      tape.insert(tape.length - 1, ' after');
      const revisions = authority.getMap('tapeRevisions');
      revisions.set(span.tapeId, (revisions.get(span.tapeId) as number) + 1);
    });

    expect(paragraph.inlineTree).toBe(firstTree);
    document.applyAccepted({ revision: 1, update: update.update });
    expect(paragraph.content).toBe('before after');
    expect(paragraph.inlineTree).not.toBe(firstTree);
    expect(paragraph.inlineTree).toBe(paragraph.inlineTree);
  });

  it('keeps checked false distinct from absence and preserves code info null', () => {
    const tree: DocumentNode = {
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '- ',
              checked: false,
              children: [{ type: 'paragraph', content: 'todo' }],
            },
            {
              type: 'list-item',
              marker: '- ',
              children: [{ type: 'paragraph', content: 'plain' }],
            },
          ],
        },
        { type: 'code-block', info: null, content: '' },
      ],
    };
    const document = CanonicalDocument.fromParsed(tree, {
      documentId: 'null-false-doc',
      actionId: 'null-false',
    });
    const exported = document.exportMarkdownTree();
    const list = exported.children![0]!;
    const checkedItem = list.children![0]!;
    const uncheckedItem = list.children![1]!;
    const code = exported.children![1]!;

    expect(checkedItem).toHaveProperty('checked', false);
    expect(Object.hasOwn(uncheckedItem, 'checked')).toBe(false);
    expect(code).toHaveProperty('info', null);
    expect(Object.hasOwn(exported, 'sharedId')).toBe(false);
    expect(Object.hasOwn(checkedItem, 'spans')).toBe(false);
  });

  it('keeps a stable read-only node view through accepted detach and reattach updates', () => {
    const document = CanonicalDocument.fromParsed(
      { type: 'document', children: [{ type: 'paragraph', content: 'kept' }] },
      { documentId: 'facade-doc', actionId: 'facade', authorityEpoch: 'facade-epoch' },
    );
    const root = document.root;
    const paragraph = root.children[0]!;
    const paragraphId = paragraph.sharedId;
    expect(paragraph.id).toBeTypeOf('number');
    expect(paragraph.inlineTree).toBeDefined();
    expect(viewModel in paragraph).toBe(false);
    const checkpoint = document.checkpoint();
    const detached = applyToAuthority(checkpoint, 1, (authority) => {
      const rootRecord = nodeRecord(authority, root.sharedId);
      setCell(rootRecord, 'children', 'accepted-detach', []);
    });

    document.applyAccepted({ revision: 1, update: detached.update });
    expect(document.node(paragraphId)).toBe(paragraph);
    expect(paragraph.connected).toBe(false);
    expect(paragraph.parent).toBeUndefined();
    expect(paragraph.content).toBe('kept');

    const reattached = applyToAuthority(
      { ...checkpoint, update: detached.update, acceptedRevision: 1 },
      2,
      (authority) => {
        const rootRecord = nodeRecord(authority, root.sharedId);
        setCell(rootRecord, 'children', 'accepted-reattach', [paragraphId]);
      },
    );
    document.applyAccepted({ revision: 2, update: reattached.update });
    expect(document.node(paragraphId)).toBe(paragraph);
    expect(paragraph.connected).toBe(true);
    expect(paragraph.parent).toBe(root);
  });

  it('rejects deletion of permanent records, tapes, and revision entries without changing state', () => {
    const document = CanonicalDocument.fromMarkdown('word', {
      documentId: 'continuity-delete-doc',
      actionId: 'continuity-delete',
      authorityEpoch: 'continuity-epoch',
    });
    const paragraph = document.root.children[0]!;
    const span = document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)!
      .spans[0]!;
    const before = document.checkpoint();
    const update = applyToAuthority(before, 1, (authority) => {
      const rootRecord = nodeRecord(authority, document.root.sharedId);
      setCell(rootRecord, 'children', 'continuity-detach', []);
      authority.getMap('nodes').delete(paragraph.sharedId);
      authority.getMap('tapes').delete(span.tapeId);
      authority.getMap('tapeRevisions').delete(span.tapeId);
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(
      /removed permanent node/,
    );
    expect(document.checkpoint().update).toEqual(before.update);
    expect(paragraph.content).toBe('word');
    update.authority.destroy();
  });

  it('rejects replacing an integrated node record at its existing registry key', () => {
    const document = CanonicalDocument.fromMarkdown('word', {
      documentId: 'continuity-replace-doc',
      actionId: 'continuity-replace',
      authorityEpoch: 'continuity-epoch',
    });
    const paragraph = document.root.children[0]!;
    const before = document.checkpoint();
    const update = applyToAuthority(before, 1, (authority) => {
      const nodes = authority.getMap<Y.Map<unknown>>('nodes');
      const previous = nodes.get(paragraph.sharedId)!;
      const replacement = new Y.Map<unknown>();
      for (const [key, value] of previous.entries()) replacement.set(key, value);
      nodes.set(paragraph.sharedId, replacement);
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(
      /replaced the native record/,
    );
    expect(document.checkpoint().update).toEqual(before.update);
    expect(paragraph.content).toBe('word');
    update.authority.destroy();
  });

  it('rejects replacing an integrated tape at its existing registry key', () => {
    const document = CanonicalDocument.fromMarkdown('word', {
      documentId: 'continuity-tape-replace-doc',
      actionId: 'continuity-tape-replace',
      authorityEpoch: 'continuity-epoch',
    });
    const paragraph = document.root.children[0]!;
    const span = document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)!
      .spans[0]!;
    const before = document.checkpoint();
    const update = applyToAuthority(before, 1, (authority) => {
      const tapes = authority.getMap<Y.Text>('tapes');
      const replacement = new Y.Text();
      replacement.insertEmbed(0, { grainBoundary: span.startBoundaryId });
      replacement.insert(1, 'word');
      replacement.insertEmbed(5, { grainBoundary: span.endBoundaryId });
      tapes.set(span.tapeId, replacement);
      authority.getMap('tapeRevisions').set(span.tapeId, 1);
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(
      /replaced the native tape/,
    );
    expect(document.checkpoint().update).toEqual(before.update);
    expect(paragraph.content).toBe('word');
    update.authority.destroy();
  });

  it('rejects changing the fixed root ID without changing accepted state', () => {
    const document = CanonicalDocument.fromMarkdown('word', {
      documentId: 'continuity-root-doc',
      actionId: 'continuity-root',
      authorityEpoch: 'continuity-epoch',
    });
    const before = document.checkpoint();
    const update = applyToAuthority(before, 1, (authority) => {
      authority.getMap('meta').set('rootId', 'replacement-root');
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(
      /changed the fixed root ID/,
    );
    expect(document.checkpoint().update).toEqual(before.update);
    update.authority.destroy();
  });

  it('rejects deletion of a retained interior boundary without changing state', () => {
    const document = CanonicalDocument.fromMarkdown('word', {
      documentId: 'continuity-marker-doc',
      actionId: 'continuity-marker',
      authorityEpoch: 'continuity-epoch',
    });
    const paragraph = document.root.children[0]!;
    const span = document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)!
      .spans[0]!;
    const insertion = applyToAuthority(document.checkpoint(), 1, (authority) => {
      const tape = authority.getMap<Y.Text>('tapes').get(span.tapeId)!;
      tape.insertEmbed(3, { grainBoundary: 'boundary:continuity-interior' });
      authority.getMap('tapeRevisions').set(span.tapeId, 1);
    });
    document.applyAccepted({ revision: 1, update: insertion.update });
    insertion.authority.destroy();

    const beforeDelete = document.checkpoint();
    const deletion = applyToAuthority(beforeDelete, 2, (authority) => {
      const tape = authority.getMap<Y.Text>('tapes').get(span.tapeId)!;
      tape.delete(3, 1);
      authority.getMap('tapeRevisions').set(span.tapeId, 2);
    });

    expect(() => document.applyAccepted({ revision: 2, update: deletion.update })).toThrow(
      /deleted, replaced, or reordered retained boundary/,
    );
    expect(document.checkpoint().update).toEqual(beforeDelete.update);
    expect(paragraph.content).toBe('word');
    deletion.authority.destroy();
  });

  it.each([
    ['text', 'import'],
    ['marker', 'import'],
    ['text', 'reconstruction'],
    ['marker', 'reconstruction'],
  ] as const)('advances the first %s tape revision after %s', (changeKind, startingState) => {
    const documentId = `tape-revision-${startingState}-${changeKind}`;
    const imported = CanonicalDocument.fromMarkdown('word', {
      documentId,
      actionId: documentId,
      authorityEpoch: 'tape-revision-epoch',
    });
    const document =
      startingState === 'import' ? imported : CanonicalDocument.open(imported.checkpoint());
    const paragraph = document.root.children[0]!;
    const span = document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)!
      .spans[0]!;
    expect(document.acceptedRevision).toBe(0);
    expect(document.tapeRevision(span.tapeId)).toBe(0);

    const update = applyToAuthority(document.checkpoint(), 1, (authority) => {
      const tape = authority.getMap<Y.Text>('tapes').get(span.tapeId)!;
      if (changeKind === 'text') tape.insert(2, 'X');
      else tape.insertEmbed(2, { grainBoundary: `boundary:${documentId}:new` });
      authority.getMap('tapeRevisions').set(span.tapeId, 1);
    });
    document.applyAccepted({ revision: 1, update: update.update });

    expect(document.acceptedRevision).toBe(1);
    expect(document.tapeRevision(span.tapeId)).toBe(1);
    if (changeKind === 'text') expect(paragraph.content).toBe('wXord');
    update.authority.destroy();
  });

  it('rejects a tape edit whose accepted revision was not recorded', () => {
    const document = CanonicalDocument.fromMarkdown('word', {
      documentId: 'tape-revision-missing-doc',
      actionId: 'tape-revision-missing',
      authorityEpoch: 'tape-revision-epoch',
    });
    const paragraph = document.root.children[0]!;
    const span = document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)!
      .spans[0]!;
    const before = document.checkpoint();
    const update = applyToAuthority(before, 1, (authority) => {
      authority.getMap<Y.Text>('tapes').get(span.tapeId)!.insert(2, 'X');
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(
      /changed without recording accepted revision/,
    );
    expect(document.checkpoint().update).toEqual(before.update);
    update.authority.destroy();
  });

  it('rejects a detached cycle across retained nodes without changing accepted state', () => {
    const document = CanonicalDocument.fromParsed(
      {
        type: 'document',
        children: [
          { type: 'section', marker: '#', content: 'A', children: [] },
          { type: 'section', marker: '#', content: 'B', children: [] },
        ],
      },
      { documentId: 'cycle-doc', actionId: 'cycle', authorityEpoch: 'cycle-epoch' },
    );
    const [first, second] = document.root.children;
    const checkpoint = document.checkpoint();
    const update = applyToAuthority(checkpoint, 1, (authority) => {
      const rootRecord = nodeRecord(authority, document.root.sharedId);
      setCell(rootRecord, 'children', 'cycle-detach-root', []);
      setCell(nodeRecord(authority, first!.sharedId), 'children', 'cycle-first', [
        second!.sharedId,
      ]);
      setCell(nodeRecord(authority, second!.sharedId), 'children', 'cycle-second', [
        first!.sharedId,
      ]);
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(/cycle/);
    expect(document.acceptedRevision).toBe(0);
    expect(document.checkpoint().update).toEqual(checkpoint.update);
    expect(document.validateRetainedForest().valid).toBe(true);
  });

  it.each([
    [
      'missing child',
      'missing',
      (rootId: string, firstId: string) => ({
        targetId: rootId,
        value: [firstId, 'no-such-node'],
        expected: /missing child/,
      }),
    ],
    [
      'duplicate parent',
      'parents',
      (_rootId: string, _firstId: string, secondId: string, nestedId: string) => ({
        targetId: secondId,
        value: [nestedId],
        expected: /multiple parents/,
      }),
    ],
  ])('rejects %s references in a candidate accepted update', (name, _kind, mutation) => {
    const document = CanonicalDocument.fromParsed(
      {
        type: 'document',
        children: [
          {
            type: 'section',
            marker: '#',
            content: 'A',
            children: [{ type: 'section', marker: '##', content: 'C', children: [] }],
          },
          { type: 'section', marker: '#', content: 'B', children: [] },
        ],
      },
      {
        documentId: `invalid-${name}`,
        actionId: `invalid-${name}`,
        authorityEpoch: 'invalid-epoch',
      },
    );
    const [first, second] = document.root.children;
    const nested = first!.children[0]!;
    const checkpoint = document.checkpoint();
    const target = mutation(
      document.root.sharedId,
      first!.sharedId,
      second!.sharedId,
      nested.sharedId,
    );
    const update = applyToAuthority(checkpoint, 1, (authority) => {
      setCell(nodeRecord(authority, target.targetId), 'children', `bad-${name}`, target.value);
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(
      target.expected,
    );
    expect(document.acceptedRevision).toBe(0);
    update.authority.destroy();
  });

  it('rejects illegal kinds and overlapping empty insertion spans', () => {
    const invalidKindDoc = CanonicalDocument.fromParsed(
      { type: 'document', children: [{ type: 'paragraph', content: '' }] },
      {
        documentId: 'illegal-kind-doc',
        actionId: 'illegal-kind',
        authorityEpoch: 'illegal-kind-epoch',
      },
    );
    const paragraphId = invalidKindDoc.root.children[0]!.sharedId;
    const illegalKindUpdate = applyToAuthority(invalidKindDoc.checkpoint(), 1, (authority) => {
      setCell(nodeRecord(authority, paragraphId), 'kind', 'illegal-kind-cell', 'image');
    });
    expect(() =>
      invalidKindDoc.applyAccepted({ revision: 1, update: illegalKindUpdate.update }),
    ).toThrow(/illegal/);

    const overlapDoc = CanonicalDocument.fromParsed(
      {
        type: 'document',
        children: [
          { type: 'paragraph', content: '' },
          { type: 'paragraph', content: '' },
        ],
      },
      {
        documentId: 'empty-overlap-doc',
        actionId: 'empty-overlap',
        authorityEpoch: 'empty-overlap-epoch',
      },
    );
    const [left, right] = overlapDoc.root.children;
    const spans = cellValue<unknown[]>(
      nodeRecordFromCheckpoint(overlapDoc.checkpoint(), left!.sharedId),
      'spans',
    );
    const overlapUpdate = applyToAuthority(overlapDoc.checkpoint(), 1, (authority) => {
      setCell(nodeRecord(authority, right!.sharedId), 'spans', 'overlap-span-cell', spans);
    });
    expect(() => overlapDoc.applyAccepted({ revision: 1, update: overlapUpdate.update })).toThrow(
      /overlapping active ownership/,
    );
  });

  it('rejects a duplicate retained marker identity on one tape', () => {
    const document = CanonicalDocument.fromParsed(
      { type: 'document', children: [{ type: 'paragraph', content: '' }] },
      {
        documentId: 'duplicate-marker-doc',
        actionId: 'duplicate-marker',
        authorityEpoch: 'marker-epoch',
      },
    );
    const checkpoint = document.checkpoint();
    const paragraph = document.root.children[0]!;
    const span = document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)!
      .spans[0]!;
    const update = applyToAuthority(checkpoint, 1, (authority) => {
      const tape = authority.getMap('tapes').get(span.tapeId) as Y.Text;
      tape.insertEmbed(1, { grainBoundary: span.startBoundaryId });
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(
      /occurs more than once/,
    );
  });

  it.each([
    ['missing visible target', 'spans', (_current: unknown[]) => [], /no insertion span/],
    [
      'unknown marker identity',
      'spans',
      (current: unknown[]) => {
        const first = current[0] as {
          tapeId: string;
          startBoundaryId: string;
          endBoundaryId: string;
        };
        return [{ ...first, startBoundaryId: 'missing-boundary' }];
      },
      /boundary is not on tape/,
    ],
    [
      'reversed marker order',
      'spans',
      (current: unknown[]) => {
        const first = current[0] as {
          tapeId: string;
          startBoundaryId: string;
          endBoundaryId: string;
        };
        return [
          { ...first, startBoundaryId: first.endBoundaryId, endBoundaryId: first.startBoundaryId },
        ];
      },
      /not in increasing order/,
    ],
  ] as const)('rejects %s in an active span', (_name, field, change, expected) => {
    const document = CanonicalDocument.fromParsed(
      { type: 'document', children: [{ type: 'paragraph', content: '' }] },
      { documentId: `span-${_name}`, actionId: `span-${_name}`, authorityEpoch: 'span-epoch' },
    );
    const targetId = document.root.children[0]!.sharedId;
    const checkpoint = document.checkpoint();
    const previous = cellValue<unknown[]>(nodeRecordFromCheckpoint(checkpoint, targetId), field);
    const update = applyToAuthority(checkpoint, 1, (authority) => {
      setCell(nodeRecord(authority, targetId), field, `span-${_name}-cell`, change(previous));
    });

    expect(() => document.applyAccepted({ revision: 1, update: update.update })).toThrow(expected);
  });

  it.each([
    ['schemaVersion', 99],
    ['normalizationVersion', 99],
  ] as const)('rejects an unknown %s during checkpoint reconstruction', (field, value) => {
    const document = CanonicalDocument.fromMarkdown('text', {
      documentId: `version-${field}`,
      actionId: field,
    });
    const checkpoint = replaceCheckpointState(document.checkpoint(), field, value);
    expect(() => CanonicalDocument.open(checkpoint)).toThrow(/unsupported/);
  });
});

function nodeRecordFromCheckpoint(checkpoint: CanonicalCheckpoint, id: string): Y.Map<unknown> {
  const document = new Y.Doc({ gc: false });
  Y.applyUpdate(document, checkpoint.update);
  return nodeRecord(document, id);
}
