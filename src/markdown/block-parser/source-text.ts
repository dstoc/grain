import type { MappedText, OutputPiece } from './types.js';

export function sourceText(text: string, sourceFrom: number): MappedText {
  return {
    text,
    pieces: text.length ? [{ kind: 'retain', sourceFrom, sourceTo: sourceFrom + text.length }] : [],
  };
}

export function sliceMappedText(source: MappedText, from: number, to: number): MappedText {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > source.text.length
  ) {
    throw new RangeError('mapped text slice is out of bounds');
  }

  const pieces: OutputPiece[] = [];
  let cursor = 0;
  for (const piece of source.pieces) {
    const length = piece.kind === 'retain' ? piece.sourceTo - piece.sourceFrom : piece.text.length;
    const start = Math.max(from, cursor);
    const end = Math.min(to, cursor + length);
    if (start < end) {
      const localFrom = start - cursor;
      const localTo = end - cursor;
      pieces.push(
        piece.kind === 'retain'
          ? {
              kind: 'retain',
              sourceFrom: piece.sourceFrom + localFrom,
              sourceTo: piece.sourceFrom + localTo,
            }
          : { kind: 'synthesize', text: piece.text.slice(localFrom, localTo) },
      );
    }
    cursor += length;
  }

  const text = source.text.slice(from, to);
  if (pieces.reduce((length, piece) => length + pieceLength(piece), 0) !== text.length) {
    throw new Error('mapped text pieces do not cover the selected text');
  }
  return { text, pieces };
}

export function pieceLength(piece: OutputPiece): number {
  return piece.kind === 'retain' ? piece.sourceTo - piece.sourceFrom : piece.text.length;
}
