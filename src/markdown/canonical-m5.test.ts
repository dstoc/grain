import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import { canonicalWriterAccess, CanonicalDocument } from './canonical-model.js';
import type { CanonicalCheckpoint, NodeId } from './canonical-model.js';

function nativeTypeId(type: Y.Map<unknown> | Y.Array<unknown> | Y.Text): string {
  const item = (
    type as unknown as {
      readonly _item: { readonly id: { readonly client: number; readonly clock: number } };
    }
  )._item;
  if (!item) throw new Error('expected integrated Yjs type');
  return `${item.id.client}:${item.id.clock}`;
}

function asSchema1(checkpoint: CanonicalCheckpoint): CanonicalCheckpoint {
  const state = new Y.Doc({ gc: false });
  Y.applyUpdate(state, checkpoint.update);
  state.transact(() => {
    const nodes = state.getMap<Y.Map<unknown>>('nodes');
    for (const record of nodes.values()) {
      const children = record.get('children');
      if (!(children instanceof Y.Array)) throw new Error('expected schema-2 child array');
      const token = record.get('childrenToken');
      if (typeof token !== 'string') throw new Error('expected schema-2 child token');
      record.set('children', { token, value: children.toArray() });
      record.delete('childrenToken');
    }
    state.getMap('meta').set('schemaVersion', 1);
  }, 'test:schema-1');
  const legacy = Object.freeze({
    ...checkpoint,
    schemaVersion: 1,
    update: Uint8Array.from(Y.encodeStateAsUpdate(state)),
  });
  state.destroy();
  return legacy;
}

describe('M5 structural storage and maintenance', () => {
  it('stores wide child lists in permanent arrays and records only moved IDs', () => {
    const children = Array.from({ length: 1000 }, (_, index) => ({
      type: 'paragraph' as const,
      content: `item-${index}`,
    }));
    const document = CanonicalDocument.fromParsed(
      { type: 'document', children },
      {
        documentId: 'm5-wide-list',
        actionId: 'm5-wide-list-import',
        authorityEpoch: 'm5-wide-epoch',
      },
    );
    const writer = new CanonicalWriter(document);
    const state = canonicalWriterAccess(document).state;
    const rootId = document.root.sharedId;
    const rootRecord = state.getMap<Y.Map<unknown>>('nodes').get(rootId)!;
    const rootChildren = rootRecord.get('children');
    if (!(rootChildren instanceof Y.Array)) throw new Error('schema 2 must use a Y.Array');
    const permanentId = nativeTypeId(rootChildren);
    const first = document.root.children[0]!;

    const result = writer.edit({ actionId: 'm5-move-first-to-end', sessionId: 'M5' }, (draft) => {
      draft.place(first.sharedId, rootId, null);
    });

    expect(result).toHaveProperty('receipt.structuralPatch.childLists');
    if (!('receipt' in result)) throw new Error('expected accepted edit');
    const childList = result.receipt.structuralPatch.childLists.find(
      (patch) => patch.nodeId === rootId,
    );
    expect(childList).toBeDefined();
    expect(
      childList!.splices.map(({ removedIds, insertedIds }) => [
        removedIds.length,
        insertedIds.length,
      ]),
    ).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(JSON.stringify(childList).length).toBeLessThan(400);
    expect(rootRecord.get('children')).toBe(rootChildren);
    expect(nativeTypeId(rootChildren)).toBe(permanentId);
    expect(rootChildren.toArray()).toEqual([
      ...document.root.children.slice(0, -1).map((node) => node.sharedId),
      first.sharedId,
    ]);
    expect(document.validate()).toEqual({ valid: true, errors: [] });

    expect(writer.undo('M5').status).toBe('applied');
    expect(rootRecord.get('children')).toBe(rootChildren);
    expect(rootChildren.toArray()[0]).toBe(first.sharedId);
    expect(writer.redo('M5').status).toBe('applied');
    expect(rootRecord.get('children')).toBe(rootChildren);
    expect(rootChildren.toArray().at(-1)).toBe(first.sharedId);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('rejects a conflicted child splice before replaying the text half of history', () => {
    const document = CanonicalDocument.fromMarkdown('alpha\n\nbeta', {
      documentId: 'm5-conflict',
      actionId: 'm5-conflict-import',
      authorityEpoch: 'm5-conflict-epoch',
    });
    const writer = new CanonicalWriter(document);
    const [first, second] = document.root.children;
    if (!first || !second) throw new Error('missing conflict fixture nodes');
    const state = canonicalWriterAccess(document).state;
    const rootRecord = state.getMap<Y.Map<unknown>>('nodes').get(document.root.sharedId)!;
    const rootChildren = rootRecord.get('children') as Y.Array<NodeId>;
    writer.edit({ actionId: 'm5-text-and-move', sessionId: 'M5' }, (draft) => {
      draft.spliceText(first.sharedId, { from: 5, to: 5, insert: '!' });
      draft.place(first.sharedId, document.root.sharedId, null);
    });
    const afterAction = document.checkpoint().update;

    // Simulate an out-of-band structural write which leaves the receipt token
    // intact. The expected-range guard must catch the changed IDs.
    state.transact(() => {
      rootChildren.delete(0, rootChildren.length);
      rootChildren.insert(0, [first.sharedId, second.sharedId]);
    }, 'test:stale-child-range');
    const conflicted = document.checkpoint().update;

    expect(writer.undo('M5')).toMatchObject({ status: 'blocked', reason: 'resource-conflict' });
    expect(document.node(first.sharedId).content).toBe('alpha!');
    expect(document.checkpoint().update).toEqual(conflicted);
    expect(conflicted).not.toEqual(afterAction);
    writer.close();
    document.close();
  });

  it('guards whole child lists by token even when the semantic IDs are unchanged', () => {
    const document = CanonicalDocument.fromMarkdown('one\n\ntwo', {
      documentId: 'm5-token-conflict',
      actionId: 'm5-token-conflict-import',
      authorityEpoch: 'm5-token-epoch',
    });
    const writer = new CanonicalWriter(document);
    const first = document.root.children[0]!;
    const rootId = document.root.sharedId;
    const rootRecord = canonicalWriterAccess(document)
      .state.getMap<Y.Map<unknown>>('nodes')
      .get(rootId)!;
    writer.edit({ actionId: 'm5-token-move', sessionId: 'M5' }, (draft) => {
      draft.place(first.sharedId, rootId, null);
    });
    const currentChildren = (rootRecord.get('children') as Y.Array<NodeId>).toArray();
    canonicalWriterAccess(document).state.transact(() => {
      rootRecord.set('childrenToken', 'same-list-new-token');
    }, 'test:children-token-conflict');
    const conflicted = document.checkpoint().update;

    expect((rootRecord.get('children') as Y.Array<NodeId>).toArray()).toEqual(currentChildren);
    expect(writer.undo('M5')).toMatchObject({ status: 'blocked', reason: 'resource-conflict' });
    expect(document.checkpoint().update).toEqual(conflicted);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('does not allocate a placeholder tape when a created inline uses transferred spans', () => {
    const document = CanonicalDocument.fromMarkdown('source', {
      documentId: 'm5-lazy-tape',
      actionId: 'm5-lazy-tape-import',
      authorityEpoch: 'm5-lazy-epoch',
    });
    const writer = new CanonicalWriter(document);
    const source = document.root.children[0]!;
    const initial = document.canonicalSnapshot();
    let createdId = '';

    const result = writer.edit(
      { actionId: 'm5-create-transfer-target', sessionId: 'M5' },
      (draft) => {
        createdId = draft.create({ type: 'paragraph' });
        draft.place(createdId, document.root.sharedId, null);
        draft.transferInlineRange({
          source: source.sharedId,
          from: 0,
          to: source.content!.length,
          destination: createdId,
          at: 0,
          affinity: 'right',
        });
      },
    );

    expect(result).toHaveProperty('receipt.structuralPatch');
    if (!('receipt' in result)) throw new Error('expected accepted edit');
    expect(result.receipt.structuralPatch.bornTapes).toEqual([]);
    expect(document.root.children.map((node) => node.content)).toEqual(['', 'source']);
    expect(document.canonicalSnapshot().tapes).toHaveLength(initial.tapes.length);
    expect(
      document.canonicalSnapshot().nodes.find(({ id }) => id === createdId)?.spans[0]?.tapeId,
    ).toBe(initial.tapes[0]?.id);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    expect(writer.undo('M5').status).toBe('applied');
    expect(document.root.children.map((node) => node.content)).toEqual(['source']);
    expect(writer.redo('M5').status).toBe('applied');
    expect(document.root.children.map((node) => node.content)).toEqual(['', 'source']);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('rebuilds schema 2 under a new epoch with semantic IDs preserved and epoch state reset', () => {
    const document = CanonicalDocument.fromMarkdown('# Heading\n\nBody', {
      documentId: 'm5-rebuild',
      actionId: 'm5-rebuild-import',
      authorityEpoch: 'epoch-old',
    });
    const writer = new CanonicalWriter(document);
    const body = document.root.children[0]!.children[0]!;
    writer.edit({ actionId: 'm5-seed-watermark', sessionId: 'editor-A' }, (draft) => {
      draft.spliceText(body.sharedId, { from: 4, to: 4, insert: '!' });
    });
    writer.edit({ actionId: 'm5-detach-retained-node', sessionId: 'editor-A' }, (draft) => {
      draft.detach(body.sharedId);
    });
    const sourceCheckpoint = document.checkpoint();
    const sourceBytes = Uint8Array.from(sourceCheckpoint.update);
    const sourceSnapshot = document.canonicalSnapshot();
    const sourceTree = document.exportMarkdownTree();
    const sourceState = canonicalWriterAccess(document).state;
    const sourceNodeIds: string[] = [];
    const pending = [document.root];
    while (pending.length) {
      const node = pending.pop()!;
      sourceNodeIds.push(node.sharedId);
      pending.push(...[...node.children].reverse());
    }
    const sourceArrayIds = [...sourceState.getMap<Y.Map<unknown>>('nodes').values()].map((record) =>
      nativeTypeId(record.get('children') as Y.Array<unknown>),
    );

    writer.close();
    const rebuilt = CanonicalDocument.rebuild(sourceCheckpoint, 'epoch-new');
    const reopened = CanonicalDocument.open(rebuilt.checkpoint);
    const rebuiltSnapshot = reopened.canonicalSnapshot();
    const rebuiltArrays = [
      ...canonicalWriterAccess(reopened).state.getMap<Y.Map<unknown>>('nodes').values(),
    ].map((record) => nativeTypeId(record.get('children') as Y.Array<unknown>));

    expect(sourceCheckpoint.update).toEqual(sourceBytes);
    expect(rebuilt.checkpoint.schemaVersion).toBe(2);
    expect(rebuilt.checkpoint.authorityEpoch).toBe('epoch-new');
    expect(rebuilt.checkpoint.acceptedRevision).toBe(0);
    expect(rebuiltSnapshot.rootId).toBe(sourceSnapshot.rootId);
    expect(rebuiltSnapshot.nodes.map(({ id }) => id)).toEqual([...sourceNodeIds].sort());
    expect(reopened.exportMarkdownTree()).toEqual(sourceTree);
    expect(rebuiltArrays).not.toEqual(sourceArrayIds);
    expect(rebuiltSnapshot.tapes.every(({ revision }) => revision === 0)).toBe(true);
    expect(rebuilt.reset).toMatchObject({
      oldSchemaVersion: 2,
      schemaVersion: 2,
      oldAuthorityEpoch: 'epoch-old',
      authorityEpoch: 'epoch-new',
      documentId: 'm5-rebuild',
      rootId: sourceSnapshot.rootId,
      preservedNodeIds: sourceNodeIds,
    });
    expect(rebuilt.reset.invalidated).toEqual([
      'nativeIdentities',
      'history',
      'pendingActions',
      'sessionWatermarks',
      'receipts',
      'selectionAnchors',
    ]);
    expect(canonicalWriterAccess(reopened).state.getMap('sessionWatermarks').size).toBe(0);
    expect(canonicalWriterAccess(reopened).state.getMap('meta').get('acceptedRevision')).toBe(0);
    expect(rebuiltSnapshot.nodes.some(({ id }) => id === body.sharedId)).toBe(false);
    expect(reopened.validate()).toEqual({ valid: true, errors: [] });
    reopened.close();
    document.close();
  });

  it('requires explicit schema-1 migration and rejects stale or malformed migrations', () => {
    const document = CanonicalDocument.fromMarkdown('# Legacy\n\nBody', {
      documentId: 'm5-legacy',
      actionId: 'm5-legacy-import',
      authorityEpoch: 'legacy-epoch',
    });
    const schema2 = document.checkpoint();
    const schema1 = asSchema1(schema2);
    const sourceTree = document.exportMarkdownTree();
    const sourceIds = document.canonicalSnapshot().nodes.map(({ id }) => id);

    expect(() => CanonicalDocument.open(schema1)).toThrow(/unsupported schema version/);
    const migration = CanonicalDocument.migrateSchema1(schema1, 'migrated-epoch');
    const migrated = CanonicalDocument.open(migration.checkpoint);

    expect(migration.reset).toMatchObject({ oldSchemaVersion: 1, schemaVersion: 2 });
    expect(migration.reset.preservedNodeIds).toEqual(sourceIds);
    expect(migrated.exportMarkdownTree()).toEqual(sourceTree);
    expect(migrated.canonicalSnapshot().nodes.map(({ id }) => id)).toEqual(sourceIds);
    expect(
      [...canonicalWriterAccess(migrated).state.getMap<Y.Map<unknown>>('nodes').values()].every(
        (record) => record.get('children') instanceof Y.Array,
      ),
    ).toBe(true);
    expect(() => CanonicalDocument.migrateSchema1(schema1, 'legacy-epoch')).toThrow(/differ/);
    expect(() =>
      CanonicalDocument.migrateSchema1({ ...schema1, schemaVersion: 3 }, 'new-epoch'),
    ).toThrow(/unsupported maintenance schema/);
    migrated.close();
    document.close();
  });

  it('rejects stale-epoch and mixed-schema accepted updates without publishing them', () => {
    const document = CanonicalDocument.fromMarkdown('current', {
      documentId: 'm5-stale-update',
      actionId: 'm5-stale-update-import',
      authorityEpoch: 'active-epoch',
    });
    const checkpoint = document.checkpoint();
    const originalBytes = Uint8Array.from(checkpoint.update);

    const stale = new Y.Doc({ gc: false });
    Y.applyUpdate(stale, checkpoint.update);
    stale.transact(() => {
      stale.getMap('meta').set('authorityEpoch', 'old-epoch');
      stale.getMap('meta').set('acceptedRevision', 1);
    }, 'test:stale-epoch');
    expect(() =>
      document.applyAccepted({ revision: 1, update: Y.encodeStateAsUpdate(stale) }),
    ).toThrow(/another authority epoch/);
    expect(document.checkpoint().update).toEqual(originalBytes);
    stale.destroy();

    const mixed = new Y.Doc({ gc: false });
    Y.applyUpdate(mixed, checkpoint.update);
    mixed.transact(() => {
      const nodes = mixed.getMap<Y.Map<unknown>>('nodes');
      const record = nodes.get(document.root.sharedId)!;
      const children = record.get('children') as Y.Array<string>;
      record.set('children', { token: 'mixed-schema-token', value: children.toArray() });
      record.delete('childrenToken');
      mixed.getMap('meta').set('acceptedRevision', 1);
    }, 'test:mixed-schema');
    expect(() =>
      document.applyAccepted({ revision: 1, update: Y.encodeStateAsUpdate(mixed) }),
    ).toThrow(/replaced children array/);
    expect(document.checkpoint().update).toEqual(originalBytes);
    mixed.destroy();
    document.close();
  });
});
