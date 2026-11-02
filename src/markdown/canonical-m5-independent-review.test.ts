import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { CanonicalDocument } from './canonical-model.js';
import { CanonicalWriter } from './canonical-actions.js';
import { canonicalWriterAccess } from './canonical-model.js';

function nativeTypeId(type: Y.Map<unknown> | Y.Array<unknown> | Y.Text): string {
  const item = (
    type as unknown as {
      readonly _item: { readonly id: { readonly client: number; readonly clock: number } };
    }
  )._item;
  if (!item) throw new Error('expected integrated Yjs type');
  return `${item.id.client}:${item.id.clock}`;
}

function fixture() {
  const document = CanonicalDocument.fromMarkdown('ab\n\nXY', {
    documentId: 'review-m5',
    actionId: 'import',
    authorityEpoch: 'old-epoch',
  });
  return { document, writer: new CanonicalWriter(document) };
}

describe('independent M5 review', () => {
  it('allocates a created tape whose final owner is a different node', () => {
    const { document, writer } = fixture();
    const [first, second] = document.root.children;
    let created = '';
    const result = writer.edit({ actionId: 'move-created-tape', sessionId: 'A' }, (draft) => {
      created = draft.create({ type: 'paragraph', content: 'NEW' });
      draft.place(created, document.root.sharedId, null);
      draft.transferInlineRange({
        source: first!.sharedId,
        from: 0,
        to: 2,
        destination: created,
        at: 3,
        affinity: 'left',
      });
      draft.transferInlineRange({
        source: created,
        from: 0,
        to: 3,
        destination: second!.sharedId,
        at: 1,
        affinity: 'right',
      });
    });
    expect(result).toHaveProperty('receipt');
    expect(document.root.children.map((n) => n.content)).toEqual(['', 'XNEWY', 'ab']);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    const reopened = CanonicalDocument.open(document.checkpoint());
    expect(reopened.canonicalSnapshot()).toEqual(document.canonicalSnapshot());
    reopened.close();
    expect(writer.undo('A').status).toBe('applied');
    expect(document.root.children.map((n) => n.content)).toEqual(['ab', 'XY']);
    expect(writer.redo('A').status).toBe('applied');
    expect(document.root.children.map((n) => n.content)).toEqual(['', 'XNEWY', 'ab']);
    const continued = writer.edit(
      { actionId: 'continue-after-transfer', sessionId: 'A' },
      (draft) => {
        draft.spliceText(second!.sharedId, { from: 5, to: 5, insert: '!' });
      },
    );
    expect(continued).toHaveProperty('receipt');
    expect(document.node(second!.sharedId).content).toBe('XNEWY!');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    const continuedReopen = CanonicalDocument.open(document.checkpoint());
    expect(continuedReopen.canonicalSnapshot()).toEqual(document.canonicalSnapshot());
    continuedReopen.close();
    writer.close();
    document.close();
  });

  it('preserves retained native resources during authority restore', () => {
    const { document, writer } = fixture();
    const first = document.root.children[0]!;
    const second = document.root.children[1]!;
    writer.edit({ actionId: 'detach', sessionId: 'A' }, (draft) => draft.detach(second.sharedId));
    const before = document.canonicalSnapshot();
    const beforeState = canonicalWriterAccess(document).state;
    const beforeRecordIds = new Map(
      [...beforeState.getMap<Y.Map<unknown>>('nodes')].map(([id, record]) => [
        id,
        nativeTypeId(record),
      ]),
    );
    const beforeArrayIds = new Map(
      [...beforeState.getMap<Y.Map<unknown>>('nodes')].map(([id, record]) => [
        id,
        nativeTypeId(record.get('children') as Y.Array<unknown>),
      ]),
    );
    const beforeTapeIds = new Map(
      [...beforeState.getMap<Y.Text>('tapes')].map(([id, tape]) => [id, nativeTypeId(tape)]),
    );
    const restored = CanonicalDocument.restore(document.checkpoint(), 'new-epoch');
    const after = restored.canonicalSnapshot();
    const newState = canonicalWriterAccess(restored).state;
    const afterRecordIds = new Map(
      [...newState.getMap<Y.Map<unknown>>('nodes')].map(([id, record]) => [
        id,
        nativeTypeId(record),
      ]),
    );
    const afterArrayIds = new Map(
      [...newState.getMap<Y.Map<unknown>>('nodes')].map(([id, record]) => [
        id,
        nativeTypeId(record.get('children') as Y.Array<unknown>),
      ]),
    );
    const afterTapeIds = new Map(
      [...newState.getMap<Y.Text>('tapes')].map(([id, tape]) => [id, nativeTypeId(tape)]),
    );
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    expect(after.tapes.map((t) => t.id)).toEqual(before.tapes.map((t) => t.id));
    expect(afterRecordIds).toEqual(beforeRecordIds);
    expect(afterArrayIds).toEqual(beforeArrayIds);
    expect(afterTapeIds).toEqual(beforeTapeIds);
    expect(restored.node(first.sharedId).content).toBe('ab');
    expect(restored.node(second.sharedId).content).toBe('XY');
    expect(restored.acceptedRevision).toBe(0);
    expect(newState.getMap('sessionWatermarks').size).toBe(0);
    expect(after.tapes.every(({ revision }) => revision === 0)).toBe(true);
    restored.close();
    writer.close();
    document.close();
  });
});
