import * as Y from 'yjs';
import { expect, it } from 'vitest';
import { CanonicalWriter } from './canonical-actions.js';
import { canonicalWriterAccess, CanonicalDocument } from './canonical-model.js';

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

for (const sourceFirst of [true, false]) {
  for (const insertedAt of [1, 4]) {
    for (const range of [
      [1, 2],
      [2, 3],
      [3, 4],
      [1, 4],
    ] as const) {
      it(`orders split sibling roots sourceFirst=${sourceFirst} insertAt=${insertedAt} transfer=${range}`, () => {
        const document = CanonicalDocument.fromMarkdown(sourceFirst ? 'ab\n\nXY' : 'XY\n\nab');
        const writer = new CanonicalWriter(document);
        const source = document.root.children[sourceFirst ? 0 : 1]!.sharedId;
        const destination = document.root.children[sourceFirst ? 1 : 0]!.sharedId;
        const initialTapeIdentity = captureTapeIdentity(document);
        let expected: (string | undefined)[] = [];
        try {
          const result = writer.edit({ actionId: 'owner-order' }, (draft) => {
            draft.spliceText(source, { from: 1, to: 1, insert: 'NEW', affinity: 'left' });
            draft.spliceText(source, {
              from: insertedAt,
              to: insertedAt,
              insert: 'Z',
              affinity: insertedAt === 1 ? 'left' : 'right',
            });
            draft.transferInlineRange({
              source,
              destination,
              from: range[0],
              to: range[1],
              at: 1,
              affinity: 'right',
            });
            expected = [draft.node(source).content, draft.node(destination).content];
          });
          if ('status' in result && result.status === 'rejected') {
            expect([document.node(source).content, document.node(destination).content]).toEqual([
              'ab',
              'XY',
            ]);
            expect(document.validate()).toEqual({ valid: true, errors: [] });
          }
          expect(result, JSON.stringify({ result, expected })).toHaveProperty('receipt');
          expect([document.node(source).content, document.node(destination).content]).toEqual(
            expected,
          );
          expect(document.validate()).toEqual({ valid: true, errors: [] });
          expectTapeIdentity(document, initialTapeIdentity);
          expect(writer.undo().status).toBe('applied');
          expect([document.node(source).content, document.node(destination).content]).toEqual([
            'ab',
            'XY',
          ]);
          expect(document.validate()).toEqual({ valid: true, errors: [] });
          expectTapeIdentity(document, initialTapeIdentity);
          expect(writer.redo().status).toBe('applied');
          expect([document.node(source).content, document.node(destination).content]).toEqual(
            expected,
          );
          expect(document.validate()).toEqual({ valid: true, errors: [] });
          expectTapeIdentity(document, initialTapeIdentity);
        } finally {
          writer.close();
          document.close();
        }
      });
    }
  }
}
