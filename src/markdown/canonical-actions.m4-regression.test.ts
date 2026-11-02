import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import { canonicalWriterAccess, CanonicalDocument } from './canonical-model.js';

type Op =
  | { type: 'edit'; node: number; from: number; to: number; insert: string }
  | { type: 'move'; source: number; from: number; to: number; destination: number; at: number };

interface NativeItem {
  readonly id: { readonly client: number; readonly clock: number };
  readonly right: NativeItem | null;
  readonly deleted: boolean;
  readonly content: unknown;
}

function nativeBoundaryItems(tape: Y.Text): readonly string[] {
  const result: string[] = [];
  let item = (tape as unknown as { readonly _start: NativeItem | null })._start;
  while (item) {
    const embed =
      item.content && typeof item.content === 'object' && 'embed' in item.content
        ? (item.content as { readonly embed: unknown }).embed
        : undefined;
    const boundaryId =
      embed && typeof embed === 'object' && 'grainBoundary' in embed
        ? (embed as { readonly grainBoundary: unknown }).grainBoundary
        : undefined;
    if (!item.deleted && typeof boundaryId === 'string') {
      result.push(`${boundaryId}@${item.id.client}:${item.id.clock}`);
    }
    item = item.right;
  }
  return result;
}

function captureTapeIdentity(document: CanonicalDocument) {
  const tapes = canonicalWriterAccess(document).state.getMap<Y.Text>('tapes');
  return new Map(
    [...tapes.entries()].map(([id, tape]) => [id, { tape, markers: nativeBoundaryItems(tape) }]),
  );
}

function expectTapeIdentity(
  document: CanonicalDocument,
  initial: ReturnType<typeof captureTapeIdentity>,
): void {
  const tapes = canonicalWriterAccess(document).state.getMap<Y.Text>('tapes');
  for (const [id, before] of initial) {
    const current = tapes.get(id);
    expect(current).toBe(before.tape);
    const markerIds = new Set(before.markers.map((marker) => marker.slice(0, marker.indexOf('@'))));
    expect(
      nativeBoundaryItems(current!).filter((marker) =>
        markerIds.has(marker.slice(0, marker.indexOf('@'))),
      ),
    ).toEqual(before.markers);
  }
}

function run(ops: Op[]) {
  const document = CanonicalDocument.fromMarkdown('ab\n\nXY\n\nuv');
  const writer = new CanonicalWriter(document);
  const ids = document.root.children.map((node) => node.sharedId);
  const expected = ['ab', 'XY', 'uv'];
  const initialTapeIdentity = captureTapeIdentity(document);
  try {
    const result = writer.edit({ actionId: 'review' }, (draft) => {
      for (const op of ops) {
        if (op.type === 'edit') {
          draft.spliceText(ids[op.node]!, { from: op.from, to: op.to, insert: op.insert });
          expected[op.node] =
            expected[op.node]!.slice(0, op.from) + op.insert + expected[op.node]!.slice(op.to);
        } else {
          const text = expected[op.source]!.slice(op.from, op.to);
          draft.transferInlineRange({
            source: ids[op.source]!,
            destination: ids[op.destination]!,
            from: op.from,
            to: op.to,
            at: op.at,
            affinity: 'right',
          });
          expected[op.source] =
            expected[op.source]!.slice(0, op.from) + expected[op.source]!.slice(op.to);
          expected[op.destination] =
            expected[op.destination]!.slice(0, op.at) +
            text +
            expected[op.destination]!.slice(op.at);
        }
      }
      expect(ids.map((id) => draft.node(id).content)).toEqual(expected);
    });

    if ('status' in result && result.status === 'rejected') {
      expect(ids.map((id) => document.node(id).content)).toEqual(['ab', 'XY', 'uv']);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    }
    expect(result, JSON.stringify({ ops, result, expected })).toHaveProperty('receipt');
    expect(ids.map((id) => document.node(id).content)).toEqual(expected);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    expectTapeIdentity(document, initialTapeIdentity);

    expect(writer.undo().status).toBe('applied');
    expect(ids.map((id) => document.node(id).content)).toEqual(['ab', 'XY', 'uv']);
    expectTapeIdentity(document, initialTapeIdentity);
    expect(writer.redo().status).toBe('applied');
    expect(ids.map((id) => document.node(id).content)).toEqual(expected);
    expectTapeIdentity(document, initialTapeIdentity);

    const snapshot = document.canonicalSnapshot();
    const reopened = CanonicalDocument.open(document.checkpoint());
    expect(reopened.canonicalSnapshot()).toEqual(snapshot);
    expect(reopened.validate()).toEqual({ valid: true, errors: [] });
    reopened.close();
  } finally {
    writer.close();
    document.close();
  }
}

describe('M4 fragment composition', () => {
  it.each([0, 1, 2])('moves a split action-local buffer range at destination offset %i', (at) => {
    run([
      { type: 'edit', node: 0, from: 1, to: 1, insert: 'NEW' },
      { type: 'move', source: 0, from: 1, to: 2, destination: 1, at },
    ]);
  });

  it.each([
    ['grow', 'LONGER'],
    ['shrink', 'Q'],
    ['delete', ''],
  ] as const)('supports repeated new-text transfer followed by %s', (_name, insert) => {
    run([
      { type: 'edit', node: 0, from: 1, to: 1, insert: 'NEW' },
      { type: 'move', source: 0, from: 1, to: 4, destination: 1, at: 1 },
      { type: 'move', source: 1, from: 1, to: 4, destination: 2, at: 1 },
      { type: 'edit', node: 2, from: 1, to: 4, insert },
    ]);
  });

  it('edits the source before moved action-local text in the same action', () => {
    run([
      { type: 'edit', node: 0, from: 1, to: 1, insert: 'NEW' },
      { type: 'move', source: 0, from: 1, to: 4, destination: 1, at: 1 },
      { type: 'edit', node: 0, from: 1, to: 1, insert: 'more' },
    ]);
  });

  it('edits the destination after moved action-local text in the same action', () => {
    run([
      { type: 'edit', node: 0, from: 1, to: 1, insert: 'NEW' },
      { type: 'move', source: 0, from: 1, to: 4, destination: 1, at: 1 },
      { type: 'edit', node: 1, from: 4, to: 4, insert: 'more' },
    ]);
  });

  it.each([
    ['grow', 'LONGER'],
    ['shrink', 'Q'],
    ['delete', ''],
  ] as const)('supports partial action-local transfer followed by %s', (_name, insert) =>
    run([
      { type: 'edit', node: 0, from: 1, to: 1, insert: 'NEW' },
      { type: 'move', source: 0, from: 2, to: 3, destination: 1, at: 1 },
      { type: 'edit', node: 1, from: 1, to: 2, insert },
    ]),
  );

  it.each([false, true])('can edit a draft-created source after transfer: %s', (editSource) => {
    const document = CanonicalDocument.fromMarkdown('target');
    const writer = new CanonicalWriter(document);
    const initialTapeIdentity = captureTapeIdentity(document);
    try {
      const result = writer.edit({ actionId: 'created' }, (draft) => {
        const source = draft.create({ type: 'paragraph', content: 'NEW' });
        draft.place(source, document.root.sharedId, null);
        draft.transferInlineRange({
          source,
          from: 0,
          to: 3,
          destination: document.root.children[0]!.sharedId,
          at: 1,
          affinity: 'right',
        });
        if (editSource) draft.spliceText(source, { from: 0, to: 0, insert: 'source' });
      });

      expect(result).toHaveProperty('receipt');
      expect(document.root.children.map((node) => node.content)).toEqual([
        'tNEWarget',
        editSource ? 'source' : '',
      ]);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
      expectTapeIdentity(document, initialTapeIdentity);

      const snapshot = document.canonicalSnapshot();
      const reopened = CanonicalDocument.open(document.checkpoint());
      expect(reopened.canonicalSnapshot()).toEqual(snapshot);
      reopened.close();

      expect(writer.undo().status).toBe('applied');
      expect(document.root.children.map((node) => node.content)).toEqual(['target']);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
      expectTapeIdentity(document, initialTapeIdentity);
      expect(writer.redo().status).toBe('applied');
      expect(document.root.children.map((node) => node.content)).toEqual([
        'tNEWarget',
        editSource ? 'source' : '',
      ]);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
      expectTapeIdentity(document, initialTapeIdentity);
    } finally {
      writer.close();
      document.close();
    }
  });
});
