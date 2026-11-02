import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { mapTextEdit } from './canonical-text.js';
import type { Span } from './canonical-model.js';

function tape(start: string, content: string, end: string, middle: string[] = []) {
  const doc = new Y.Doc({ gc: false });
  const text = doc.getText('tape');
  let index = 0;
  text.insertEmbed(index++, { grainBoundary: start });
  for (const marker of middle) {
    if (content) {
      text.insert(index, content);
      index += content.length;
    }
    text.insertEmbed(index++, { grainBoundary: marker });
    content = '';
  }
  if (content) {
    text.insert(index, content);
    index += content.length;
  }
  text.insertEmbed(index, { grainBoundary: end });
  return { doc, text };
}

describe('mapTextEdit', () => {
  it('maps selections around embeds to string-only native runs', () => {
    const { doc, text } = tape('head', 'a', 'tail', ['interior']);
    text.insert(3, '😀b');
    const span: Span = {
      tapeId: 'tape-1',
      startBoundaryId: 'head',
      endBoundaryId: 'tail',
    };

    const mapped = mapTextEdit([span], new Map([['tape-1', text]]), {
      from: 1,
      to: 3,
      insert: '',
    });

    expect(mapped.projectedText).toBe('a😀b');
    expect(mapped.deletions).toEqual([{ tapeId: 'tape-1', from: 3, to: 5 }]);
    expect(mapped.insertion).toEqual({
      tapeId: 'tape-1',
      index: 3,
      spanIndex: 0,
      affinity: 'right',
    });
    expect(
      text
        .toDelta()
        .flatMap((part: { readonly insert: unknown }) =>
          typeof part.insert === 'string' ? [] : [part.insert],
        ),
    ).toEqual([
      { grainBoundary: 'head' },
      { grainBoundary: 'interior' },
      { grainBoundary: 'tail' },
    ]);
    doc.destroy();
  });

  it('uses explicit affinity at a multi-span seam and counts both tapes’ markers', () => {
    const { doc: leftDoc, text: leftTape } = tape('left-head', 'ab', 'left-tail');
    const { doc: rightDoc, text: rightTape } = tape('right-head', 'cd', 'right-tail');
    const spans: readonly Span[] = [
      { tapeId: 'left', startBoundaryId: 'left-head', endBoundaryId: 'left-tail' },
      { tapeId: 'right', startBoundaryId: 'right-head', endBoundaryId: 'right-tail' },
    ];
    const tapes = new Map([
      ['left', leftTape],
      ['right', rightTape],
    ]);

    const left = mapTextEdit(spans, tapes, { from: 2, to: 2, insert: '!', affinity: 'left' });
    const right = mapTextEdit(spans, tapes, { from: 2, to: 2, insert: '!', affinity: 'right' });
    const across = mapTextEdit(spans, tapes, { from: 1, to: 3, insert: '' });

    expect(left.insertion).toMatchObject({ tapeId: 'left', index: 3, spanIndex: 0 });
    expect(right.insertion).toMatchObject({ tapeId: 'right', index: 1, spanIndex: 1 });
    expect(across.deletions).toEqual([
      { tapeId: 'left', from: 2, to: 3 },
      { tapeId: 'right', from: 1, to: 2 },
    ]);
    leftDoc.destroy();
    rightDoc.destroy();
  });

  it('supports an explicit empty-span insertion target', () => {
    const { doc: firstDoc, text: first } = tape('h1', 'a', 't1');
    const { doc: emptyDoc, text: empty } = tape('h2', '', 't2');
    const { doc: thirdDoc, text: third } = tape('h3', 'b', 't3');
    const spans: readonly Span[] = [
      { tapeId: 'one', startBoundaryId: 'h1', endBoundaryId: 't1' },
      { tapeId: 'empty', startBoundaryId: 'h2', endBoundaryId: 't2' },
      { tapeId: 'three', startBoundaryId: 'h3', endBoundaryId: 't3' },
    ];
    const mapped = mapTextEdit(
      spans,
      new Map([
        ['one', first],
        ['empty', empty],
        ['three', third],
      ]),
      { from: 1, to: 1, insert: 'x', spanIndex: 1, affinity: 'right' },
    );

    expect(mapped.insertion).toMatchObject({ tapeId: 'empty', index: 1, spanIndex: 1 });
    firstDoc.destroy();
    emptyDoc.destroy();
    thirdDoc.destroy();
  });

  it('rejects out-of-bounds and surrogate-splitting edits and malformed insertions', () => {
    const { doc, text } = tape('head', 'a😀b', 'tail');
    const span: Span = { tapeId: 't', startBoundaryId: 'head', endBoundaryId: 'tail' };
    const tapes = new Map([['t', text]]);

    expect(() => mapTextEdit([span], tapes, { from: 2, to: 2, insert: 'x' })).toThrow(
      'splits a surrogate pair',
    );
    expect(() => mapTextEdit([span], tapes, { from: 0, to: 5, insert: '' })).toThrow(
      'out of bounds',
    );
    expect(() => mapTextEdit([span], tapes, { from: 0, to: 0, insert: '\ud800' })).toThrow(
      'unpaired high surrogate',
    );
    doc.destroy();
  });
});
