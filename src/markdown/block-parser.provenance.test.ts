import { describe, expect, it } from 'vitest';
import { isInlineNode, type DocumentNode, type MarkdownNode } from './node.js';
import { createBlockParser, isLiteralParagraphInput, parseBlocks } from './block-parser/api.js';
import type { OutputPiece, ParserConversionPlan } from './block-parser/types.js';

function inlineTexts(node: MarkdownNode, path: number[] = []): { key: string; text: string }[] {
  const result = isInlineNode(node) ? [{ key: path.join('.') || 'root', text: node.content }] : [];
  for (const [index, child] of (node.children ?? []).entries()) {
    result.push(...inlineTexts(child, [...path, index]));
  }
  return result;
}

function expectValidPlan(source: string, plan: ParserConversionPlan): void {
  const texts = new Map(inlineTexts(plan.output).map(({ key, text }) => [key, text]));
  const retained: { from: number; to: number }[] = [];
  for (const [key, pieces] of Object.entries(plan.inlinePieces)) {
    const reconstructed = pieces
      .map((piece) => {
        if (piece.kind === 'synthesize') return piece.text;
        retained.push({ from: piece.sourceFrom, to: piece.sourceTo });
        return source.slice(piece.sourceFrom, piece.sourceTo);
      })
      .join('');
    expect(reconstructed).toBe(texts.get(key));
  }
  expect(Object.keys(plan.inlinePieces).sort()).toEqual([...texts.keys()].sort());

  retained.sort((a, b) => a.from - b.from || a.to - b.to);
  let cursor = 0;
  const expectedConsumed: { from: number; to: number }[] = [];
  for (const range of retained) {
    expect(range.from).toBeGreaterThanOrEqual(cursor);
    if (range.from > cursor) expectedConsumed.push({ from: cursor, to: range.from });
    cursor = range.to;
  }
  if (cursor < source.length) expectedConsumed.push({ from: cursor, to: source.length });
  expect(plan.consumed).toEqual(expectedConsumed);
}

describe('block parser provenance', () => {
  it.each([
    ['ordinary paragraph', 'ordinary text'],
    ['an incomplete heading prefix', '#'],
    ['a multiline paragraph', 'first line\nsecond line'],
  ])('keeps %s on the literal input path', (_name, source) => {
    expect(isLiteralParagraphInput(source)).toBe(true);
  });

  it.each([
    ['ATX heading', '# heading '],
    ['setext heading', 'Title\n==='],
    ['list item', '- item'],
    ['block quote', '> quoted'],
    ['incomplete quote prefix', '>'],
    ['fenced code block', '```ts\ncode\n```'],
    ['paragraph split', 'first\n\nsecond'],
    ['terminal newline conversion', 'last\n'],
  ])('routes %s through parser conversion', (_name, source) => {
    expect(isLiteralParagraphInput(source)).toBe(false);
  });

  it.each([
    ['space', ' '],
    ['tab', '\t'],
    ['nonbreaking space', '\u00a0'],
    ['vertical tab', '\u000b'],
    ['form feed', '\u000c'],
  ])('uses parser heading recognition for %s after ATX markers', (_name, whitespace) => {
    const source = `#${whitespace}Heading`;

    expect(parseBlocks(source).node.children?.[0]?.type).toBe('section');
    expect(isLiteralParagraphInput(source)).toBe(false);
  });

  it('classifies a parser-created empty root paragraph without inventing source text', () => {
    const result = parseBlocks('', { provenance: true });
    expect(inlineTexts(result.node).map(({ text }) => text)).toEqual(['']);
    expect(result.provenance.inlinePieces).toEqual({ '0': [] });
    expect(result.provenance.consumed).toEqual([]);
    expectValidPlan('', result.provenance);
  });

  it.each([
    ['ATX heading', '# Head\n', ['Head'], [[2, 6]]],
    ['task list item', '- [x] same\n', ['same'], [[6, 10]]],
    ['quote prefix', '> quote\n', ['quote'], [[2, 7]]],
    [
      'nested task and list continuation',
      '> - [ ] body\n>   tail\n',
      ['body\ntail'],
      [
        [8, 12],
        [12, 13],
        [17, 21],
      ],
    ],
    ['tab quote prefix', '>\tquote\n', ['quote'], [[2, 7]]],
    ['setext heading', 'Title\n===\n', ['Title'], [[0, 5]]],
    ['fenced code body', '```ts\nbody\n```', ['body'], [[6, 10]]],
    [
      'real paragraph newline',
      'first\nsecond',
      ['first\nsecond'],
      [
        [0, 5],
        [5, 6],
        [6, 12],
      ],
    ],
    ['final newline is consumed', 'last\n', ['last'], [[0, 4]]],
  ])('%s reports exact retained source slices', (_name, source, expectedTexts, expectedRanges) => {
    const result = parseBlocks(source, { provenance: true });
    const plan = result.provenance;
    expect(plan).toBeDefined();
    const texts = inlineTexts(result.node);
    expect(texts.map(({ text }) => text)).toEqual(expectedTexts);
    expectValidPlan(source, plan!);
    expect(
      Object.values(plan!.inlinePieces)
        .flatMap((pieces) => pieces)
        .filter(
          (piece): piece is Extract<OutputPiece, { kind: 'retain' }> => piece.kind === 'retain',
        )
        .map(({ sourceFrom, sourceTo }) => [sourceFrom, sourceTo]),
    ).toEqual(expectedRanges);
  });

  it('preserves the same provenance across every chunk boundary and snapshot resume', () => {
    const source =
      '# Heading\n\n> - [x] repeated repeated\n>   continuation\n>\tTabbed repeated\n\n```ts\nconst x = 1;\n```';
    const expected = parseBlocks(source, { provenance: true }).provenance!;
    const characterParser = createBlockParser(undefined, { provenance: true });
    for (let boundary = 0; boundary <= source.length; boundary++) {
      if (boundary > 0) characterParser.push(source[boundary - 1]!);
      const oneShotPrefix = createBlockParser(undefined, { provenance: true });
      oneShotPrefix.push(source.slice(0, boundary));
      const visibleState = (parser: ReturnType<typeof createBlockParser>) => {
        const snapshot = parser.snapshot();
        return {
          root: snapshot.root,
          pendingText: snapshot.pendingText,
          projectedPending: snapshot.projectedPending,
          sourceTracking: snapshot.sourceTracking,
          sourceOffset: snapshot.sourceOffset,
          receivedSourceLength: snapshot.receivedSourceLength,
          inlinePieces: snapshot.inlinePieces,
        };
      };
      expect(visibleState(characterParser), `checkpoint ${boundary}`).toEqual(
        visibleState(oneShotPrefix),
      );
    }

    const schedules = [
      [...source].map((character) => character),
      ...Array.from({ length: source.length + 1 }, (_, boundary) => [
        source.slice(0, boundary),
        source.slice(boundary),
      ]),
    ];
    for (const schedule of schedules) {
      let parser = createBlockParser(undefined, { provenance: true });
      for (const chunk of schedule) {
        parser.push(chunk);
        parser = createBlockParser(parser.snapshot());
      }
      const node = parser.finish().serialize() as DocumentNode;
      const actual = parser.getConversionPlan(source);
      expect(node).toEqual(expected.output);
      expect(actual).toEqual(expected);
      expectValidPlan(source, actual);
    }
  });

  it('does not add parser preview text to settled provenance', () => {
    const source = 'first\nsecond';
    const parser = createBlockParser(undefined, { provenance: true });
    parser.push('first\nsec');
    const snapshot = parser.snapshot();
    const resumed = createBlockParser(snapshot);
    resumed.push('ond');
    const plan = resumed.finish().serialize() as DocumentNode;
    expect(inlineTexts(plan).map(({ text }) => text)).toEqual(['first\nsecond']);
    expectValidPlan(source, resumed.getConversionPlan(source));
  });

  it('does not enable provenance after restoring an untracked snapshot', () => {
    const parser = createBlockParser();
    parser.push('settled\n');
    expect(() => createBlockParser(parser.snapshot(), { provenance: true })).toThrow(
      'cannot enable provenance after restoring an untracked parser snapshot',
    );
  });

  it('keeps provisional parser construction out of user undo history', () => {
    const parser = createBlockParser(undefined, { provenance: true });
    parser.push('>');
    parser.push(' - [x] body\n');
    const tree = parser.finish();

    expect(tree.canUndo(tree.root)).toBe(false);
    expect(tree.canRedo(tree.root)).toBe(false);
  });
});
