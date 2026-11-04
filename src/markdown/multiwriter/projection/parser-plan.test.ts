import { afterEach, expect, test } from 'vitest';
import { createBlockParser, parseBlocks } from '../../block-parser/api.js';
import type { ParserConversionPlan } from '../../block-parser/types.js';
import { isInlineNode } from '../../node.js';
import type { MarkdownNode } from '../../node.js';
import type { NativeTextRange, ResourceId, ResourceKind } from '../contracts.js';
import { actorId } from '../contracts.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import {
  projectMarkdown,
  bindParserConversion,
  prepareParserConversion,
  ProjectionError,
} from './index.js';
import type { OutputBinding, SourceFragment } from './index.js';

const fixtures: NativeFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.destroy()));
function fixture(text: string) {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [...text].map((text, i) => ({ id: `P${i}`, text })),
    },
  ]);
  fixtures.push(f);
  return f;
}
function bindings(f: NativeFixture, plan: ParserConversionPlan): OutputBinding[] {
  const result: OutputBinding[] = [];
  let ordinal = 10000;
  function id<K extends ResourceKind>(kind: K): ResourceId<K> {
    return {
      kind,
      ordinal: ordinal++,
      birth: {
        type: 'action',
        action: { actor: actorId('00000000000000000000000000000001'), sequence: 1n },
      },
    };
  }
  let first = true;
  function visit(
    node: MarkdownNode,
    path: number[],
    parent: OutputBinding | null,
    predecessor: OutputBinding | null,
  ): void {
    if (node.type === 'document') {
      let previous: OutputBinding | null = null;
      for (const [i, child] of (node.children ?? []).entries()) {
        visit(child, [i], null, previous);
        previous = result.at(-1)!;
      }
      return;
    }
    const inline = isInlineNode(node);
    const source = inline && first;
    if (inline) first = false;
    const binding: OutputBinding = {
      key: path.join('.') || 'root',
      node: source ? f.id('P', 'node') : id('node'),
      ...(inline
        ? {
            flow: source ? f.id('fP', 'flow') : id('flow'),
            run: source ? f.id('rP', 'run') : id('run'),
          }
        : {}),
      occurrence: id('occurrence'),
      slot: {
        parent: parent?.node ?? f.id('root', 'node'),
        predecessor: predecessor?.occurrence ?? null,
      },
    };
    result.push(binding);
    let previous: OutputBinding | null = null;
    for (const [i, child] of (node.children ?? []).entries()) {
      const start = result.length;
      visit(child, [...path, i], binding, previous);
      previous = result[start]!;
    }
  }
  visit(plan.output, [], null, null);
  return result;
}
function input(
  f: NativeFixture,
  text: string,
  plan = parseBlocks(text, { provenance: true }).provenance!,
) {
  const cache = f.peers.get('A')!;
  const fragments = cache.range(f.homes[0]!.cell).map(({ text, range }) => ({ text, range }));
  return { source: f.id('P', 'node'), text, fragments, plan, bindings: bindings(f, plan) };
}

test.each([
  '',
  '#',
  '> ',
  '- [',
  'same repeated same',
  '# repeated repeated😀\n',
  '- [x] task😀\n',
  '```ts\ncode😀\n```',
  '> - [ ] body\n>   tail\n',
  'Title\n===\n',
  'first\n\nsecond',
])('binds exact parser provenance without allocating: %j', (text) => {
  const f = fixture(text);
  const source = input(f, text);
  const before = f.peers.get('A')!.snapshot(f.id('tP', 'tape'));
  const prepared = prepareParserConversion(source);
  const inlineText = (node: MarkdownNode): string[] => [
    ...(isInlineNode(node) ? [node.content] : []),
    ...(node.children ?? []).flatMap(inlineText),
  ];
  expect(
    prepared.outputs
      .filter((output) => ['paragraph', 'section', 'code-block'].includes(output.type))
      .map((output) => output.pieces.map((piece) => piece.text).join('')),
  ).toEqual(inlineText(source.plan.output));
  expect(
    prepared.syntaxMask
      .map((range) =>
        f.peers
          .get('A')!
          .lookup(range)
          .map((part) => part.text)
          .join(''),
      )
      .join(''),
  ).toBe(source.plan.consumed.map(({ from, to }) => text.slice(from, to)).join(''));
  expect(f.peers.get('A')!.snapshot(f.id('tP', 'tape'))).toEqual(before);
});

test('all UTF-16 two-chunk splits, character streaming and snapshot/resume bind identical native identities', () => {
  const text = '# Heading😀\n\n> - [x] repeated repeated\n>   continuation\n\n```ts\ncode\n```';
  const f = fixture(text);
  const full = input(f, text);
  const expected = prepareParserConversion(full);
  for (let cut = 0; cut <= text.length; cut++) {
    let parser = createBlockParser(undefined, { provenance: true });
    parser.push(text.slice(0, cut));
    parser = createBlockParser(parser.snapshot());
    parser.push(text.slice(cut));
    parser.finish();
    const plan = parser.getConversionPlan(text);
    expect(prepareParserConversion({ ...full, plan }), `cut ${cut}`).toEqual(expected);
  }
  let parser = createBlockParser(undefined, { provenance: true });
  for (let i = 0; i < text.length; i++) {
    parser.push(text[i]!);
    parser = createBlockParser(parser.snapshot());
  }
  parser.finish();
  expect(prepareParserConversion({ ...full, plan: parser.getConversionPlan(text) })).toEqual(
    expected,
  );
});

test('joined multi-tape source resolves consumed syntax across both tapes without matching repeated strings', () => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [{ id: 'P0', text: '#' }],
    },
    {
      id: 'Q',
      parent: 'root',
      role: 'inline',
      flow: 'fQ',
      run: 'rQ',
      tape: 'tQ',
      cells: [...' repeated😀'].map((text, i) => ({ id: `Q${i}`, text })),
    },
  ]);
  fixtures.push(f);
  f.author('A1', (f) => [f.join('fQ', 'P:end')]);
  const ownership = f.reduce('A');
  const fragments: SourceFragment[] = ownership
    .raw(f.id('fP', 'flow'))
    .flatMap((entry) =>
      entry.type === 'cell' ? entry.fragments.map(({ text, range }) => ({ text, range })) : [],
    );
  const text = fragments.map((fragment) => fragment.text).join('');
  const plan = parseBlocks(text, { provenance: true }).provenance!;
  const prepared = prepareParserConversion({
    source: f.id('P', 'node'),
    text,
    plan,
    fragments,
    bindings: bindings(f, plan),
  });
  expect(prepared.syntaxMask).toEqual([f.aliases.get('P0'), f.aliases.get('Q0')]);
  expect(prepared.outputs[0]!.pieces.map((piece) => piece.text).join('')).toBe('repeated😀');
});

test('rejects incomplete coverage, duplicate paths/identities, inconsistent output and half-surrogates', () => {
  const f = fixture('# x😀');
  const original = input(f, '# x😀');
  const bad: Parameters<typeof prepareParserConversion>[0][] = [
    { ...original, fragments: original.fragments.slice(1) },
    { ...original, bindings: [] },
    { ...original, bindings: [...original.bindings, original.bindings[0]!] },
    {
      ...original,
      plan: {
        ...original.plan,
        inlinePieces: { '0': [{ kind: 'retain', sourceFrom: 3, sourceTo: 5 }] },
      },
    },
    { ...original, plan: { ...original.plan, consumed: [] } },
    {
      ...original,
      plan: {
        ...original.plan,
        inlinePieces: { '0': [{ kind: 'retain', sourceFrom: 4, sourceTo: 5 }] },
      },
    },
    {
      ...original,
      plan: { ...original.plan, inlinePieces: { wrong: original.plan.inlinePieces['0']! } },
    },
  ];
  for (const candidate of bad)
    expect(() => prepareParserConversion(candidate)).toThrow(ProjectionError);
  const repeated = fixture('aa');
  const source = input(repeated, 'aa');
  expect(() =>
    prepareParserConversion({ ...source, fragments: [source.fragments[0]!, source.fragments[0]!] }),
  ).toThrow(/Repeated source identity/);
});

test('real author-native newline synthesis binds once; incomplete or stale manifests publish nothing', () => {
  const f = fixture('a');
  const source = input(f, 'a');
  // Explicit parser contract fixture: editable synthesis must have a real native birth.
  // Current block grammar usually retains line breaks; the adapter also supports synthesize.
  const plan: ParserConversionPlan = {
    output: { type: 'document', children: [{ type: 'paragraph', content: 'a\n' }] },
    inlinePieces: {
      '0': [
        { kind: 'retain', sourceFrom: 0, sourceTo: 1 },
        { kind: 'synthesize', text: '\n' },
      ],
    },
    consumed: [],
  };
  const prepared = prepareParserConversion({ ...source, plan });
  let packetId: ResourceId<'interpretation'>;
  let outputBinding: OutputBinding;
  f.author('A1', (f) => {
    packetId = f.allocate('conversion', 'interpretation');
    const move = f.move('P', 'root');
    if (move.type !== 'MoveBlock') throw new Error();
    outputBinding = { ...source.bindings[0]!, occurrence: move.occurrence, slot: move.slot };
    return f.insert('P0', '\n', 'P:end');
  });
  const original = f.actions.get('A1')!;
  f.actions.set('A1', {
    ...original,
    action: {
      ...original.action,
      allocations: [...original.action.allocations, { type: 'interpretation', id: packetId! }],
    },
  });
  const action = f.envelope('A1');
  const cache = f.peers.get('A')!;
  const range = action.nativeManifest.flatMap((birth): NativeTextRange[] =>
    birth.type === 'text' ? [{ tape: birth.tape, ...birth.native }] : [],
  )[0]!;
  const request = prepared.synthesis[0]!.request;
  const authored = {
    ...prepared,
    outputs: prepared.outputs.map((output) => ({ ...output, binding: outputBinding! })),
  };
  const read = (range: NativeTextRange) =>
    cache
      .lookup(range)
      .map((part) => part.text)
      .join('');
  const result = bindParserConversion(
    authored,
    packetId!,
    action,
    [{ request, ranges: [range] }],
    read,
    f.genesis.allocations,
  );
  expect(result.packet.synthesizedText).toEqual([range]);
  expect(result.outputs[0]!.ranges.map(read).join('')).toBe('a\n');
  const published = {
    ...action,
    effects: [...action.effects, { type: 'Interpret' as const, packet: result.packet }],
  };
  const view = projectMarkdown({
    genesis: f.genesis,
    genesisManifest: f.bodies.get('G')!.nativeManifest,
    actions: [{ action: published, births: [] }],
    native: cache,
    birthContent: [
      { node: f.id('root', 'node'), intervals: [] },
      { node: f.id('P', 'node'), intervals: [f.homes[0]!.cell] },
    ],
  }).view;
  expect(view.root.children[0]!.content).toBe('a\n');
  expect(
    view.root.children[0]!.fragments.filter((fragment) => fragment.visible).map(
      (fragment) => fragment.range,
    ),
  ).toEqual(result.outputs[0]!.ranges);
  const before = cache.snapshot(f.id('tP', 'tape'));
  expect(() =>
    bindParserConversion(authored, packetId!, action, [], read, f.genesis.allocations),
  ).toThrow(/Incomplete synthesis/);
  expect(() =>
    bindParserConversion(
      authored,
      packetId!,
      { ...action, nativeManifest: [] },
      [{ request, ranges: [range] }],
      read,
      f.genesis.allocations,
    ),
  ).toThrow(/born in the author/);
  expect(() =>
    bindParserConversion(
      authored,
      packetId!,
      action,
      [{ request, ranges: [f.aliases.get('P0')!] }],
      read,
      f.genesis.allocations,
    ),
  ).toThrow(/text mismatch/);
  const invalid = {
    ...authored,
    outputs: authored.outputs.map((output) => ({
      ...output,
      binding: { ...output.binding, flow: { ...output.binding.flow!, ordinal: 999999 } },
    })),
  };
  expect(() =>
    bindParserConversion(
      invalid,
      packetId!,
      action,
      [{ request, ranges: [range] }],
      read,
      f.genesis.allocations,
    ),
  ).toThrow(/flow\/run/);
  expect(cache.snapshot(f.id('tP', 'tape'))).toEqual(before);
});

test('same-action source text cannot be reused as synthesized editable text', () => {
  const f = fixture('');
  let interpretation: ResourceId<'interpretation'>;
  let occurrence: ResourceId<'occurrence'>;
  f.author('A1', (f) => {
    interpretation = f.allocate('conversion', 'interpretation');
    const move = f.move('P', 'root');
    if (move.type !== 'MoveBlock') throw new Error();
    occurrence = move.occurrence;
    return f.insert('source', 'a', 'P:end');
  });
  const entry = f.actions.get('A1')!;
  f.actions.set('A1', {
    ...entry,
    action: {
      ...entry.action,
      allocations: [...entry.action.allocations, { type: 'interpretation', id: interpretation! }],
    },
  });
  const action = f.envelope('A1');
  const cache = f.peers.get('A')!;
  const source = cache.range(f.homes[0]!.cell).map(({ text, range }) => ({ text, range }));
  const prepared = prepareParserConversion({
    source: f.id('P', 'node'),
    text: 'a',
    fragments: source,
    plan: {
      output: { type: 'document', children: [{ type: 'paragraph', content: 'aa' }] },
      inlinePieces: {
        '0': [
          { kind: 'retain', sourceFrom: 0, sourceTo: 1 },
          { kind: 'synthesize', text: 'a' },
        ],
      },
      consumed: [],
    },
    bindings: [
      {
        key: '0',
        node: f.id('P', 'node'),
        flow: f.id('fP', 'flow'),
        run: f.id('rP', 'run'),
        occurrence: occurrence!,
        slot: { parent: f.id('root', 'node'), predecessor: null },
      },
    ],
  });
  expect(() =>
    bindParserConversion(
      prepared,
      interpretation!,
      action,
      [{ request: prepared.synthesis[0]!.request, ranges: [source[0]!.range] }],
      (range) =>
        cache
          .lookup(range)
          .map((part) => part.text)
          .join(''),
      f.genesis.allocations,
    ),
  ).toThrow(/fresh identities distinct from parser source/);
});
