import { resourceKey } from './layout/index.js';
import { expect, test } from 'vitest';
import { parseBlocks } from '../block-parser/api.js';
import { serializeToString } from '../block-serializer.js';
import { ReplicaNetwork } from '../../../test/multiwriter/network.js';
import { referenceFactory } from '../../../test/multiwriter/reference/factory.js';
import type {
  ContractTrace,
  Intent,
  Observation,
  SeedBlock,
  TraceAction,
} from '../../../test/multiwriter/trace.js';
const equal = (actual: unknown, expected: unknown, context: string) =>
  expect(actual, context).toEqual(expected);
const paragraph = (id: string, text: string, parent = 'root'): SeedBlock => ({
  id,
  parent,
  role: 'inline',
  flow: `f${id}`,
  run: `r${id}`,
  tape: `t${id}`,
  cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
});
const root: SeedBlock = { id: 'root', parent: null, role: 'root' };
function action(
  id: string,
  intents: readonly Intent[],
  dependencies: readonly string[] = [],
  lamport = 1n,
): TraceAction {
  return {
    id,
    peer: id[0],
    sequence: BigInt(id.slice(1)),
    lamport,
    dependencies,
    group: id,
    intents,
  };
}
async function exercise(
  seed: readonly SeedBlock[],
  actions: readonly TraceAction[],
  check: (state: Observation) => void | Promise<void>,
) {
  const trace: ContractTrace = {
    version: 3,
    id: 'projection-composition',
    sections: ['13'],
    purpose: 'Real parser/property/native projection composition.',
    genesis: 'G',
    peers: ['A', 'B', 'C'],
    seed,
    steps: actions.map((action) => ({ type: 'author', action })),
  };
  const network = await ReplicaNetwork.open(referenceFactory(trace), trace, equal);
  try {
    for (const command of actions) {
      for (const dependency of command.dependencies) {
        const owner = dependency[0];
        if (
          owner === command.peer ||
          (await network.observe(command.peer)).ready.includes(dependency)
        )
          continue;
        await network.executeContractStep({
          type: 'deliver',
          from: owner,
          to: command.peer,
          actions: (await network.observe(owner)).held,
          route: 'peer',
        });
      }
      await network.step({ type: 'author', action: command });
    }
    for (const from of trace.peers)
      for (const to of trace.peers)
        if (from !== to)
          await network.executeContractStep({
            type: 'deliver',
            from,
            to,
            actions: (await network.observe(from)).held,
            route: 'catch-up',
          });
    for (const peer of trace.peers) {
      await network.step({ type: 'replay', peer });
      await check(await network.observe(peer));
    }
  } finally {
    await network.dispose();
  }
}

test.each(['# repeated repeated😀', '```ts\ncode😀\n```', 'Title\n===\n'])(
  'parser conversion, native syntax masks and export/reparse: %j',
  async (text) => {
    await exercise(
      [root, paragraph('P', text)],
      [action('A1', [{ type: 'parse', source: 'P', packet: 'parsed' }])],
      (state) => {
        expect(state.activePackets).toEqual(['parsed']);
        const parsed = parseBlocks(text).node;
        expect(state.markdown).toBe(serializeToString(parsed));
        expect(serializeToString(parseBlocks(state.markdown).node)).toBe(state.markdown);
        expect(state.raw!.runs).toHaveLength(1);
        expect(Object.values(state.nativeText).join('')).toBe(text);
      },
    );
  },
);

test('explicit demotion retains the parser packet mask and native identities', async () => {
  await exercise(
    [root, paragraph('P', '# repeated repeated')],
    [
      action('A1', [{ type: 'parse', source: 'P', packet: 'heading' }]),
      action(
        'A2',
        [{ type: 'properties', node: 'P', values: { presentation: 'paragraph', marker: null } }],
        ['A1'],
        2n,
      ),
    ],
    (state) => {
      expect(state.view).toEqual([{ id: 'P', parent: 'root', kind: 'paragraph' }]);
      expect(state.markdown).toBe('repeated repeated\n');
      expect(state.hidden).toEqual(['P0', 'P1']);
      expect(state.activePackets).toEqual(['heading']);
    },
  );
});

test('list/task edits use typed properties and preserve independent sibling typing', async () => {
  const seed = [
    root,
    { id: 'L', parent: 'root', role: 'list' as const },
    { id: 'I', parent: 'L', role: 'list-item' as const },
    paragraph('P', 'task', 'I'),
  ];
  await exercise(
    seed,
    [
      action('A1', [{ type: 'properties', node: 'I', values: { marker: '-', checked: true } }]),
      action('B1', [{ type: 'insert', cell: 'BX', text: '!', tape: 'tP', slot: 'P:end' }]),
    ],
    (state) => {
      expect(state.markdown).toContain('[x] task!');
      expect(state.rawParents).toEqual({ root: null, L: 'root', I: 'L', P: 'I' });
      expect(state.visible.P).toEqual(['P0', 'P1', 'P2', 'P3', 'BX']);
    },
  );
});

test('a losing parser wrapper packet cannot hide surviving source text', async () => {
  const wrapper: SeedBlock = { id: 'W', parent: 'root', role: 'quote' };
  await exercise(
    [root, paragraph('P', '# repeated')],
    [
      action('A1', [
        { type: 'create', block: wrapper, predecessor: null },
        {
          type: 'interpret',
          packet: 'wrapped',
          source: 'P',
          presentation: 'section',
          mask: ['P0', 'P1'],
          wrappers: ['W'],
          placements: [{ node: 'P', parent: 'W', predecessor: null }],
        },
      ]),
      action('B1', [
        {
          type: 'interpret',
          packet: 'literal-code',
          source: 'P',
          presentation: 'code',
          mask: [],
          wrappers: [],
        },
      ]),
    ],
    (state) => {
      expect(state.activePackets).toEqual(['literal-code']);
      expect(state.view).toEqual([{ id: 'P', parent: 'root', kind: 'code-block' }]);
      expect(state.hidden).toEqual([]);
      expect(state.visible.P).toHaveLength(10);
      expect(state.rawParents.W).toBe('root');
      expect(state.rawParents.P).toBe('root');
    },
  );
});

test('same-action editable synthesis has a distinct retained home and survives peer typing', async () => {
  const output = paragraph('N', '', 'root');
  await exercise(
    [root, paragraph('P', 'a')],
    [
      action('A1', [
        { type: 'create', block: output, predecessor: 'P:birth' },
        { type: 'insert', cell: 'newline', text: '\n', tape: 'tN', slot: 'N:home-end' },
        {
          type: 'interpret',
          packet: 'synthesis',
          source: 'P',
          presentation: 'paragraph',
          mask: [],
          wrappers: [],
          synthesized: ['newline'],
        },
      ]),
      action('B1', [{ type: 'insert', cell: 'BX', text: 'x', tape: 'tP', slot: 'P:end' }]),
    ],
    (state) => {
      expect(state.nativeText.newline).toBe('\n');
      expect(state.visible.N).toEqual(['newline']);
      expect(state.visible.P).toEqual(['P0', 'BX']);
      expect(state.nativeIds.newline).not.toEqual(state.nativeIds.P0);
      expect(new Set(state.raw!.homes.map((home) => resourceKey(home.cell.tape))).size).toBe(2);
    },
  );
});

test('Unicode split retains whole surrogate identities and combining source units', async () => {
  await exercise(
    [root, paragraph('P', 'a😀e\u0301z')],
    [
      action('A1', [
        {
          type: 'split',
          source: 'P',
          basis: ['P0', 'P1', 'P2', 'P3', 'P4'],
          after: 'P1',
          marker: 'cut:S',
          retainedSide: 'left',
          node: 'S',
          flow: 'fS',
          run: 'rS',
          parent: 'root',
          predecessor: 'P:birth',
        },
      ]),
      action('B1', [{ type: 'insert', cell: 'BX', text: 'Ω', tape: 'tP', slot: 'P:after-😀' }]),
    ],
    (state) => {
      expect(state.nativeIds.P1.length).toBe(2);
      expect(state.markdown).toBe('a😀\n\nΩe\u0301z\n');
      expect(state.hidden).toEqual([]);
    },
  );
});

test('action-local native text transfers without copying and remains editable at its original lineage', async () => {
  await exercise(
    [root, paragraph('P', 'a')],
    [
      action('A1', [
        { type: 'create', block: paragraph('N', 'xy'), predecessor: 'P:birth' },
        { type: 'transfer', cells: ['N0', 'N1'], destinationSlot: 'P:end', run: 'rTransfer' },
      ]),
      action(
        'A2',
        [{ type: 'insert', cell: 'AS', text: '!', tape: 'tN', slot: 'N:after-x' }],
        ['A1'],
        2n,
      ),
    ],
    (state) => {
      expect(state.visible.P).toEqual(['P0', 'N0', 'AS', 'N1']);
      expect(state.visible.N).toEqual([]);
      expect(state.cellRuns.N0).toBe('rTransfer');
      expect(state.cellRuns.N1).toBe('rTransfer');
      expect(state.cellRuns.AS).toBe('rTransfer');
      expect(Object.values(state.nativeText).filter((text) => text === 'x')).toHaveLength(1);
    },
  );
});

test('state-vector catch-up is peer-specific and retains original carrier prefixes', async () => {
  const first = action('A1', [
    { type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' },
  ]);
  const second = action(
    'A2',
    [{ type: 'insert', cell: 'AY', text: 'y', tape: 'tP', slot: 'P:end' }],
    ['A1'],
    2n,
  );
  const trace: ContractTrace = {
    version: 3,
    id: 'feedback',
    sections: ['13'],
    purpose: 'Real peer-specific state-vector feedback.',
    genesis: 'G',
    peers: ['A', 'B', 'C'],
    seed: [root, paragraph('P', 'a')],
    steps: [
      { type: 'author', action: first },
      { type: 'author', action: second },
    ],
  };
  const factory = referenceFactory(trace),
    a = await factory.open({ peer: 'A', genesis: trace }),
    b = await factory.open({ peer: 'B', genesis: trace }),
    c = await factory.open({ peer: 'C', genesis: trace });
  try {
    await a.author(first);
    await b.receive(await a.exportUpdate(['A1'], undefined, 'B'), 'peer');
    const before = await a.isolationState();
    await a.receiveControl(await b.control(), 'B');
    expect(await a.isolationState()).toEqual(before);
    await a.author(second);
    const delta = await a.exportUpdate(['A1', 'A2'], undefined, 'B');
    const bootstrap = await a.exportUpdate(['A1', 'A2'], undefined, 'C');
    expect(delta.byteLength).toBeLessThan(bootstrap.byteLength);
    await b.receive(delta, 'catch-up');
    await c.receive(bootstrap, 'catch-up');
    expect((await b.observe()).visible.P).toEqual(['P0', 'AX', 'AY']);
    expect((await c.observe()).raw).toEqual((await b.observe()).raw);
    expect((await c.observe()).nativeIds).toEqual((await b.observe()).nativeIds);
  } finally {
    await Promise.all([a.dispose(), b.dispose(), c.dispose()]);
  }
});

// Three-peer catch-up and cold replay can exceed the default 5s deadline on CI.
test('multi-block paste-shaped construction and undo retain independent peer typing', async () => {
  await exercise(
    [root, paragraph('P', 'a')],
    [
      action('A1', [
        { type: 'create', block: paragraph('N', 'one'), predecessor: 'P:birth' },
        { type: 'create', block: paragraph('M', 'two'), predecessor: 'N:birth' },
      ]),
      action(
        'B1',
        [{ type: 'insert', cell: 'BZ', text: '?', tape: 'tN', slot: 'N:end' }],
        ['A1'],
        2n,
      ),
      action(
        'A2',
        [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
        ['B1'],
        3n,
      ),
    ],
    (state) => {
      expect(state.markdown).toBe('a\n\n?\n');
      expect(state.visible).toEqual({ P: ['P0'], N: ['BZ'] });
      expect(state.rawParents).toEqual({ root: null, P: 'root', N: 'root', M: 'root' });
      expect(state.nativeText.M0).toBe('t');
      expect(state.raw!.homes).toHaveLength(3);
    },
  );
}, 20000);

test('explicit left/right seam affinity types on opposite sides of the same retained cut', async () => {
  const split: Intent = {
    type: 'split',
    source: 'P',
    basis: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'],
    after: 'P1',
    marker: 'cut:S',
    retainedSide: 'left',
    node: 'S',
    flow: 'fS',
    run: 'rS',
    parent: 'root',
    predecessor: 'P:birth',
  };
  await exercise(
    [root, paragraph('P', 'abcdef')],
    [
      action('A1', [split]),
      action(
        'B1',
        [{ type: 'insert', cell: 'BY', text: 'y', tape: 'tP', slot: 'S:start:right' }],
        ['A1'],
        2n,
      ),
      action(
        'A2',
        [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'S:start:left' }],
        ['A1'],
        2n,
      ),
    ],
    (state) => {
      expect(state.markdown).toBe('abx\n\nycdef\n');
      expect(state.cellRuns.AX).toBe('rP');
      expect(state.cellRuns.BY).toBe('rS');
    },
  );
});
