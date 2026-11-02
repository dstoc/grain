import { describe, expect, it } from 'vitest';
import { createBlockParser, parseBlocks } from './block-parser/api.js';
import { CanonicalWriter } from './canonical-actions.js';
import { CanonicalDocument } from './canonical-model.js';
import { applyParserConversion } from './canonical-promotion.js';

const sources = [
  '# one\n> two\n> three',
  'first\n\nsecond\n\nthird',
  '> first\n> second\n\nlast',
  '- first\n- second\n- third',
  '> - [x] same\n>   same\n>   same',
  '```ts\n\nbody\n\n```\n\nlast',
  '# \n\nbody',
  '<!-- -->\n\n# body',
  '\n\n# body',
  '# one\n## two\n### three\nlast',
];

describe('M4 review probes', () => {
  it('converts preexisting draft text with multiple outputs', () => {
    const source = '- first\n- second';
    const document = CanonicalDocument.fromParsed({
      type: 'document',
      children: [{ type: 'paragraph', content: source }],
    });
    const writer = new CanonicalWriter(document);
    try {
      const id = document.root.children[0]!.sharedId;
      writer.edit({ actionId: 'explicit-existing-promote', sessionId: 'A' }, (draft) => {
        const current = draft.node(id).content!;
        expect(
          applyParserConversion(
            draft,
            document.root.sharedId,
            id,
            current,
            parseBlocks(current, { provenance: true }).provenance,
          ),
        ).toBe(true);
      });
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
      expect(writer.undo('A').status).toBe('applied');
      expect(document.node(id).content).toBe(source);
      expect(writer.redo('A').status).toBe('applied');
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
    } finally {
      writer.close();
      document.close();
    }
  });

  it('retains remote body text in a new leaf when undo restores the original paragraph', () => {
    const document = CanonicalDocument.fromMarkdown('first second');
    const writer = new CanonicalWriter(document);
    try {
      const id = document.root.children[0]!.sharedId;
      const accept = (
        sessionId: string,
        nodeId: string,
        from: number,
        to: number,
        insert: string,
        actionId: string,
      ) => {
        const request = writer.prepareTextInput(
          nodeId,
          { from, to, insert },
          { actionId, sessionId },
        );
        writer.admitSession(sessionId);
        const result = writer.apply(request, {
          sessionId,
          authorityEpoch: request.authorityEpoch,
          sessionSequence: request.sessionSequence,
        });
        expect(result.status).toBe('pending');
        if (result.status !== 'pending') throw new Error(JSON.stringify(result));
        writer.publish(result.pending);
      };
      accept('A', id, 5, 6, '\n\n', 'split-by-promotion');
      const right = document.root.children[1]!;
      expect(right.content).toBe('second');
      accept('B', right.sharedId, 6, 6, '!', 'remote-body');
      expect(writer.undo('A').status).toBe('applied');
      expect(document.node(id).content).toBe('first second!');
      expect(document.validate().valid).toBe(true);
      expect(writer.redo('A').status).toBe('applied');
      expect(document.root.children.map((node) => node.content)).toEqual(['first', 'second!']);
      expect(document.validate().valid).toBe(true);
    } finally {
      writer.close();
      document.close();
    }
  });

  it.each(['😀', '# 😀', '> 😀', '- 😀', '```\n😀\n```'])(
    'streams whole Unicode code points %j',
    (source) => {
      const parser = createBlockParser(undefined, { provenance: true });
      for (const character of source) parser.push(character);
      parser.finish();
      expect(parser.getConversionPlan(source)).toEqual(
        parseBlocks(source, { provenance: true }).provenance,
      );
    },
  );

  it.each(sources)('finalizes a resumed snapshot at every input boundary %j', (source) => {
    const parser = createBlockParser(undefined, { provenance: true });
    for (let boundary = 0; boundary <= source.length; boundary++) {
      if (boundary) parser.push(source[boundary - 1]!);
      const resumed = createBlockParser(parser.snapshot());
      resumed.finish();
      expect(resumed.getConversionPlan(source.slice(0, boundary)), `at ${boundary}`).toEqual(
        parseBlocks(source.slice(0, boundary), { provenance: true }).provenance,
      );
    }
    parser.finish();
  });

  it('composes parser provenance with text inserted in an explicit draft', () => {
    const document = CanonicalDocument.fromMarkdown('');
    const writer = new CanonicalWriter(document);
    try {
      const id = document.root.children[0]!.sharedId;
      const source = '- first\n- second';
      const result = writer.edit(
        { actionId: 'explicit-insert-and-promote', sessionId: 'A' },
        (draft) => {
          draft.spliceText(id, { from: 0, to: 0, insert: source });
          const current = draft.node(id).content!;
          const plan = parseBlocks(current, { provenance: true }).provenance;
          expect(applyParserConversion(draft, document.root.sharedId, id, current, plan)).toBe(
            true,
          );
        },
      );
      expect('receipt' in result, JSON.stringify(result)).toBe(true);
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
      expect(writer.undo('A').status).toBe('applied');
      expect(document.node(id).content).toBe('');
      expect(writer.redo('A').status).toBe('applied');
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
    } finally {
      writer.close();
      document.close();
    }
  });

  it.each(sources)('promotes and replays multiline input %j', (source) => {
    const document = CanonicalDocument.fromMarkdown('');
    const writer = new CanonicalWriter(document);
    try {
      const id = document.root.children[0]!.sharedId;
      const request = writer.prepareTextInput(
        id,
        { from: 0, to: 0, insert: source },
        {
          actionId: 'promotion',
          sessionId: 'A',
        },
      );
      writer.admitSession('A');
      const result = writer.apply(request, {
        sessionId: 'A',
        authorityEpoch: request.authorityEpoch,
        sessionSequence: request.sessionSequence,
      });
      expect(result.status, JSON.stringify(result)).toBe('pending');
      if (result.status !== 'pending') return;
      writer.publish(result.pending);
      const expected = parseBlocks(source).node;
      expect(document.exportMarkdownTree()).toEqual(expected);
      expect(document.validate().valid).toBe(true);
      expect(writer.undo('A').status).toBe('applied');
      expect(document.root.children[0]).toMatchObject({
        sharedId: id,
        type: 'paragraph',
        content: '',
      });
      expect(document.validate().valid).toBe(true);
      expect(writer.redo('A').status).toBe('applied');
      expect(document.exportMarkdownTree()).toEqual(expected);
      expect(document.validate().valid).toBe(true);
    } finally {
      writer.close();
      document.close();
    }
  });

  it.each(['😀', '# 😀', '> 😀', '- 😀', '```\n😀\n```'])('streams UTF-16 units %j', (source) => {
    const parser = createBlockParser(undefined, { provenance: true });
    for (let index = 0; index < source.length; index++) parser.push(source[index]!);
    parser.finish();
    expect(parser.getConversionPlan(source)).toEqual(
      parseBlocks(source, { provenance: true }).provenance,
    );
  });
});
