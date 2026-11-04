import type { ContractTrace, Intent, Observation, SeedBlock, Step, TraceAction } from './trace.js';

const root: SeedBlock = { id: 'root', parent: null, role: 'root' };
function paragraph(id: string, text: string, parent = 'root'): SeedBlock {
  return {
    id,
    parent,
    role: 'inline',
    flow: `f${id}`,
    run: `r${id}`,
    tape: `t${id}`,
    cells: [...text].map((value, index) => ({ id: `${id}${index}`, text: value })),
  };
}
const p = paragraph('P', 'abcdef');
const q = paragraph('Q', 'XY');
const ids = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
const text = { P0: 'a', P1: 'b', P2: 'c', P3: 'd', P4: 'e', P5: 'f' };
const base = {
  rawParents: { root: null, P: 'root' },
  flowParents: { fP: 'block:P' },
  runFlows: { rP: 'fP' },
  cellRuns: Object.fromEntries(ids.map((id) => [id, 'rP'])),
  nativeText: text,
  skeletons: { rP: ids },
  slots: { 'P:start': 'rP', 'P:end': 'rP', 'P:after-b': 'rP', 'P:after-c': 'rP' },
  visible: { P: ids },
  hidden: [],
  deletedNodes: [],
  view: [{ id: 'P', parent: 'root', kind: 'paragraph' }],
} satisfies Partial<Observation>;
function action(
  id: string,
  intents: readonly Intent[],
  dependencies: readonly string[] = [],
  lamport = 1n,
  group = id,
): TraceAction {
  return { id, peer: id[0], sequence: BigInt(id.slice(1)), lamport, dependencies, group, intents };
}
const author = (a: TraceAction): Step => ({ type: 'author', action: a });
const expect = (peer: string, state: Partial<Observation>): Step => ({
  type: 'expect',
  peer,
  state,
});
const deliver = (from: string, to: string, actions: readonly string[]): Step => ({
  type: 'deliver',
  from,
  to,
  actions,
  route: 'peer',
});
const split = (
  node: string,
  after: string | null,
  retainedSide: 'left' | 'right' = 'left',
): Intent => ({
  type: 'split',
  source: 'P',
  basis: ids,
  after,
  marker: `cut:${node}`,
  retainedSide,
  node,
  flow: `f${node}`,
  run: `r${node}`,
  parent: 'root',
  predecessor: retainedSide === 'right' ? null : 'P:birth',
});
const deletion = (coveredCells: readonly string[] = ids): Intent => ({
  type: 'delete-subtree',
  tag: 'dA',
  target: 'P',
  observedNodes: ['P'],
  coveredCells,
  joinedFlows: [],
});
function trace(
  id: string,
  sections: readonly string[],
  purpose: string,
  steps: readonly Step[],
  seed: readonly SeedBlock[] = [root, p],
): ContractTrace {
  return { version: 3, id, sections, purpose, genesis: 'G', peers: ['A', 'B', 'C'], seed, steps };
}
function concurrent(a: TraceAction, b: TraceAction, state: Partial<Observation>): Step[] {
  return [
    author(a),
    author(b),
    deliver(b.peer, 'C', [b.id]),
    deliver(a.peer, 'C', [a.id]),
    expect('C', state),
    deliver(a.peer, 'C', [a.id]),
    expect('C', state),
    deliver(b.peer, a.peer, [b.id]),
    expect(a.peer, state),
    deliver(a.peer, b.peer, [a.id]),
    expect(b.peer, state),
  ];
}
const cutState = {
  ...base,
  rawParents: { root: null, P: 'root', L: 'root', R: 'root' },
  flowParents: { fP: 'block:P', fL: 'block:L', fR: 'block:R' },
  runFlows: { rP: 'fP', rL: 'fL', rR: 'fR' },
  cellRuns: { P0: 'rP', P1: 'rP', P2: 'rL', P3: 'rR', P4: 'rR', P5: 'rR' },
  skeletons: { rP: ids, rL: ['P2', 'P3', 'P4', 'P5'], rR: ['P3', 'P4', 'P5'] },
  visible: { P: ['P0', 'P1'], L: ['P2'], R: ['P3', 'P4', 'P5'] },
  view: ['P', 'L', 'R'].map((id) => ({ id, parent: 'root', kind: 'paragraph' })),
  markdown: 'ab\n\nc\n\ndef\n',
} satisfies Partial<Observation>;

export const semanticCorpus: readonly ContractTrace[] = [
  trace(
    'cuts-earlier-first',
    ['6.5'],
    'Different cuts preserve ab | c | def; cohort order is cut order, not sibling LWW order.',
    concurrent(action('A1', [split('L', 'P1')]), action('B1', [split('R', 'P2')]), cutState),
  ),
  trace(
    'cuts-later-first',
    ['6.5'],
    'Reverse semantic priority still preserves both cuts and their identities.',
    concurrent(action('A1', [split('R', 'P2')]), action('B1', [split('L', 'P1')]), cutState),
  ),
  trace(
    'split-at-zero-retains-original-right',
    ['6.5'],
    'The original P retains the right side and its native text identity.',
    [
      author(action('A1', [split('L', null, 'right')])),
      expect('A', {
        ...base,
        rawParents: { root: null, L: 'root', P: 'root' },
        flowParents: { fP: 'block:P', fL: 'block:L' },
        runFlows: { rP: 'fP', rL: 'fL' },
        view: [{ id: 'L', parent: 'root', kind: 'paragraph' }, ...base.view],
        visible: { L: [], P: ids },
        slots: { ...base.slots, 'L:empty': 'rL' },
      }),
    ],
  ),
  trace(
    'same-gap-empty-cut',
    ['6.2', '6.5'],
    'Distinct cuts at the same gap retain an empty insertion cell; inactive markers are retained.',
    [
      ...concurrent(action('A1', [split('L', 'P1')]), action('B1', [split('R', 'P1')]), {
        rawParents: { root: null, P: 'root', L: 'root', R: 'root' },
        flowParents: { fP: 'block:P', fL: 'block:L', fR: 'block:R' },
        visible: { P: ['P0', 'P1'], L: [], R: ['P2', 'P3', 'P4', 'P5'] },
        slots: { ...base.slots, 'between-cuts': 'rL', 'L:end': 'rL', 'R:start': 'rR' },
        nativeText: { ...text, 'between-cuts': '' },
        cellRuns: {
          ...base.cellRuns,
          P2: 'rR',
          P3: 'rR',
          P4: 'rR',
          P5: 'rR',
          'between-cuts': 'rL',
        },
        view: ['P', 'L', 'R'].map((id) => ({ id, parent: 'root', kind: 'paragraph' })),
      }),
    ],
  ),
  trace(
    'cross-tape-join',
    ['5.2', '6.1', '6.6'],
    'Join nests a flow, hides only its header, and retains both tapes without copying.',
    [
      author(action('A1', [{ type: 'join', source: 'fQ', destinationSlot: 'P:end' }])),
      expect('A', {
        rawParents: { root: null, P: 'root', Q: 'root' },
        flowParents: { fP: 'block:P', fQ: 'flow:fP@P:end' },
        runFlows: { rP: 'fP', rQ: 'fQ' },
        cellRuns: { ...base.cellRuns, Q0: 'rQ', Q1: 'rQ' },
        nativeText: { ...text, Q0: 'X', Q1: 'Y' },
        skeletons: { rP: ids, rQ: ['Q0', 'Q1'] },
        visible: { P: [...ids, 'Q0', 'Q1'] },
        hidden: [],
        deletedNodes: [],
        view: base.view,
        slots: { ...base.slots, 'Q:start': 'rQ', 'Q:end': 'rQ' },
        markdown: 'abcdefXY\n',
      }),
    ],
    [root, p, q],
  ),
  trace(
    'opposing-joins',
    ['5', '6.6'],
    'The second join would cycle; the first flow edge remains effective.',
    concurrent(
      action('A1', [{ type: 'join', source: 'fQ', destinationSlot: 'P:end' }]),
      action('B1', [{ type: 'join', source: 'fP', destinationSlot: 'Q:end' }]),
      {
        rawParents: { root: null, P: 'root', Q: 'root' },
        flowParents: { fP: 'block:P', fQ: 'flow:fP@P:end' },
        runFlows: { rP: 'fP', rQ: 'fQ' },
        visible: { P: [...ids, 'Q0', 'Q1'] },
        hidden: [],
        deletedNodes: [],
        view: base.view,
        markdown: 'abcdefXY\n',
      },
    ),
    [root, p, q],
  ),
  trace(
    'split-versus-source-delete',
    ['7.3'],
    'A concurrent split cannot smuggle the deleted source suffix into a sibling.',
    concurrent(action('A1', [deletion()]), action('B1', [split('S', 'P2')]), {
      rawParents: { root: null, P: 'root', S: 'root' },
      flowParents: { fP: 'block:P', fS: 'block:S' },
      cellRuns: { P0: 'rP', P1: 'rP', P2: 'rP', P3: 'rS', P4: 'rS', P5: 'rS' },
      nativeText: text,
      hidden: ids,
      deletedNodes: ['P'],
      visible: {},
      view: [],
    }),
  ),
  trace(
    'transfer-versus-source-delete',
    ['6.4', '7.3'],
    'A concurrent transfer preserves ownership but not visibility of covered identities.',
    concurrent(
      action('A1', [deletion()]),
      action('B1', [
        { type: 'transfer', cells: ['P3', 'P4', 'P5'], destinationSlot: 'Q:end', run: 'rT' },
      ]),
      {
        rawParents: { root: null, P: 'root', Q: 'root' },
        flowParents: { fP: 'block:P', fQ: 'block:Q' },
        runFlows: { rP: 'fP', rQ: 'fQ', rT: 'fQ' },
        cellRuns: {
          P0: 'rP',
          P1: 'rP',
          P2: 'rP',
          P3: 'rT',
          P4: 'rT',
          P5: 'rT',
          Q0: 'rQ',
          Q1: 'rQ',
        },
        nativeText: { ...text, Q0: 'X', Q1: 'Y' },
        hidden: ids,
        deletedNodes: ['P'],
        visible: { Q: ['Q0', 'Q1'] },
        view: [{ id: 'Q', parent: 'root', kind: 'paragraph' }],
        markdown: 'XY\n',
      },
    ),
    [root, p, q],
  ),
  trace(
    'move-out-before-delete',
    ['7.3'],
    'Coverage is captured after a causal transfer; moved-out text survives.',
    [
      author(
        action('A1', [
          { type: 'transfer', cells: ['P3', 'P4', 'P5'], destinationSlot: 'Q:end', run: 'rT' },
        ]),
      ),
      author(action('A2', [deletion(['P0', 'P1', 'P2'])], ['A1'], 2n)),
      deliver('A', 'C', ['A2']),
      expect('C', {
        held: ['A2'],
        ready: [],
        pending: ['A2'],
        visible: { P: ids, Q: ['Q0', 'Q1'] },
      }),
      deliver('A', 'C', ['A1']),
      expect('C', {
        hidden: ['P0', 'P1', 'P2'],
        deletedNodes: ['P'],
        visible: { Q: ['Q0', 'Q1', 'P3', 'P4', 'P5'] },
        cellRuns: {
          P0: 'rP',
          P1: 'rP',
          P2: 'rP',
          P3: 'rT',
          P4: 'rT',
          P5: 'rT',
          Q0: 'rQ',
          Q1: 'rQ',
        },
        ready: ['A1', 'A2'],
        pending: [],
        markdown: 'XYdef\n',
      }),
    ],
    [root, p, q],
  ),
  trace(
    'delete-destination',
    ['6.4', '7.3'],
    'A transfer into a deleted destination is hidden and is not restored to its source.',
    concurrent(
      action('A1', [
        {
          type: 'delete-subtree',
          tag: 'dQ',
          target: 'Q',
          observedNodes: ['Q'],
          coveredCells: ['Q0', 'Q1'],
          joinedFlows: [],
        },
      ]),
      action('B1', [
        { type: 'transfer', cells: ['P3', 'P4', 'P5'], destinationSlot: 'Q:end', run: 'rT' },
      ]),
      {
        visible: { P: ['P0', 'P1', 'P2'] },
        hidden: ['P3', 'P4', 'P5', 'Q0', 'Q1'],
        deletedNodes: ['Q'],
        cellRuns: {
          P0: 'rP',
          P1: 'rP',
          P2: 'rP',
          P3: 'rT',
          P4: 'rT',
          P5: 'rT',
          Q0: 'rQ',
          Q1: 'rQ',
        },
        markdown: 'abc\n',
      },
    ),
    [root, p, q],
  ),
  trace(
    'two-delete-tags-selective-undo',
    ['7.2', '7.4'],
    'Undo one tag leaves the character hidden; undo both reveals the same native identity once.',
    [
      ...concurrent(
        action('A1', [{ type: 'delete-text', tag: 'dA', cells: ['P2'] }]),
        action('B1', [{ type: 'delete-text', tag: 'dB', cells: ['P2'] }]),
        {
          ...base,
          hidden: ['P2'],
          visible: { P: ['P0', 'P1', 'P3', 'P4', 'P5'] },
          markdown: 'abdef\n',
        },
      ),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['A1', 'B1'],
          2n,
        ),
      ),
      deliver('A', 'C', ['A2']),
      expect('C', {
        hidden: ['P2'],
        nativeText: text,
        visible: { P: ['P0', 'P1', 'P3', 'P4', 'P5'] },
      }),
      deliver('A', 'B', ['A2']),
      author(
        action(
          'B2',
          [{ type: 'control', group: 'B1', actions: ['B1'], active: false, previous: null }],
          ['A2'],
          3n,
        ),
      ),
      deliver('B', 'C', ['B2']),
      expect('C', { ...base, markdown: 'abcdef\n', retainedActions: ['A1', 'B1', 'A2', 'B2'] }),
      author(
        action(
          'B3',
          [{ type: 'control', group: 'B1', actions: ['B1'], active: true, previous: 'B2' }],
          ['B2'],
          4n,
        ),
      ),
      deliver('B', 'C', ['B3']),
      expect('C', {
        nativeText: text,
        hidden: ['P2'],
        visible: { P: ['P0', 'P1', 'P3', 'P4', 'P5'] },
      }),
    ],
  ),
  trace(
    'exact-observed-text-delete',
    ['6.3', '7.2'],
    'An unseen insertion inside a deleted character range survives text deletion.',
    concurrent(
      action('A1', [{ type: 'delete-text', tag: 'dA', cells: ['P1', 'P2'] }]),
      action('B1', [{ type: 'insert', cell: 'BX', text: 'x', tape: 'tP', slot: 'P:after-b' }]),
      {
        nativeText: { ...text, BX: 'x' },
        cellRuns: { ...base.cellRuns, BX: 'rP' },
        hidden: ['P1', 'P2'],
        visible: { P: ['P0', 'BX', 'P3', 'P4', 'P5'] },
        markdown: 'axdef\n',
      },
    ),
  ),
  trace(
    'undo-split-after-peer-insert',
    ['6.3', '7.4'],
    'Retracting a split returns surviving peer text through the same tape identities.',
    [
      author(action('A1', [split('S', 'P2')])),
      deliver('A', 'B', ['A1']),
      author(
        action(
          'B1',
          [{ type: 'insert', cell: 'BX', text: 'x', tape: 'tP', slot: 'P:after-c' }],
          ['A1'],
          2n,
        ),
      ),
      deliver('B', 'A', ['B1']),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['B1'],
          3n,
        ),
      ),
      deliver('A', 'C', ['A2']),
      deliver('A', 'C', ['A1']),
      expect('C', { ready: ['A1'], pending: ['A2'] }),
      deliver('B', 'C', ['B1']),
      expect('C', {
        nativeText: { ...text, BX: 'x' },
        cellRuns: { ...base.cellRuns, BX: 'rP' },
        flowParents: { fP: 'block:P', fS: 'block:S' },
        visible: { P: ['P0', 'P1', 'P2', 'BX', 'P3', 'P4', 'P5'] },
        view: base.view,
        retainedActions: ['A1', 'B1', 'A2'],
        markdown: 'abcxdef\n',
      }),
    ],
  ),
];

export const deletionAndProjectionCorpus: readonly ContractTrace[] = [
  trace(
    'concurrent-child-inherits-delete',
    ['7.3'],
    'A child concurrently born under P inherits deletion even after moving to root.',
    [
      ...concurrent(
        action('A1', [deletion()]),
        action('B1', [{ type: 'create', block: paragraph('N', 'n', 'P'), predecessor: null }]),
        {
          deletedNodes: ['P', 'N'],
          hidden: [...ids, 'N0'],
          visible: {},
          view: [],
        },
      ),
      author(
        action(
          'B2',
          [{ type: 'move', node: 'N', parent: 'root', predecessor: null, standaloneFlow: 'fN' }],
          ['A1', 'B1'],
          2n,
        ),
      ),
      deliver('B', 'C', ['B2']),
      expect('C', {
        rawParents: { root: null, P: 'root', N: 'root' },
        deletedNodes: ['P', 'N'],
        hidden: [...ids, 'N0'],
        visible: {},
        view: [],
      }),
    ],
  ),
  trace(
    'birth-after-observed-undo',
    ['7.3'],
    'A creation after seeing deletion retracted is not assigned the old inherited tombstone.',
    [
      author(action('A1', [deletion()])),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['A1'],
          2n,
        ),
      ),
      deliver('A', 'B', ['A1', 'A2']),
      author(
        action(
          'B1',
          [{ type: 'create', block: paragraph('N', 'n', 'P'), predecessor: null }],
          ['A2'],
          3n,
        ),
      ),
      deliver('B', 'C', ['B1']),
      deliver('A', 'C', ['A2', 'A1']),
      expect('C', {
        rawParents: { root: null, P: 'root', N: 'P' },
        deletedNodes: [],
        hidden: [],
        visible: { P: ids, N: ['N0'] },
        view: [
          { id: 'P', parent: 'root', kind: 'paragraph' },
          { id: 'N', parent: 'root', kind: 'paragraph' },
        ],
      }),
    ],
  ),
  trace(
    'stale-split-does-not-tombstone-separated-sibling',
    ['7.3'],
    'Deleting P after an earlier split does not tombstone that sibling or its already-separated text.',
    [
      author(action('A1', [split('S', 'P2')])),
      author(action('A2', [deletion(['P0', 'P1', 'P2'])], ['A1'], 2n)),
      author(action('B1', [split('T', 'P1')])),
      deliver('A', 'C', ['A1', 'A2']),
      deliver('B', 'C', ['B1']),
      expect('C', {
        deletedNodes: ['P'],
        hidden: ['P0', 'P1', 'P2'],
        visible: { S: ['P3', 'P4', 'P5'] },
        view: [{ id: 'S', parent: 'root', kind: 'paragraph' }],
        markdown: 'def\n',
      }),
    ],
  ),
  trace(
    'delete-does-not-make-raw-cycle-safe',
    ['5'],
    'Deletion hides a node but does not remove raw graph edges for cycle checking.',
    [
      author(
        action('A1', [
          { type: 'move', node: 'U', parent: 'V', predecessor: null, standaloneFlow: null },
        ]),
      ),
      author(
        action(
          'A2',
          [
            {
              type: 'delete-subtree',
              tag: 'dU',
              target: 'U',
              observedNodes: ['U'],
              coveredCells: [],
              joinedFlows: [],
            },
          ],
          ['A1'],
          2n,
        ),
      ),
      author(
        action(
          'A3',
          [{ type: 'move', node: 'V', parent: 'U', predecessor: null, standaloneFlow: null }],
          ['A2'],
          3n,
        ),
      ),
      expect('A', { rawParents: { root: null, U: 'V', V: 'root' }, deletedNodes: ['U'], view: [] }),
    ],
    [root, { id: 'U', parent: 'root', role: 'quote' }, { id: 'V', parent: 'root', role: 'quote' }],
  ),
  trace(
    'undone-wrapper-scaffolds-peer-child',
    ['7.4'],
    'Undo wrapper creation retains a scaffold for an independent surviving child.',
    [
      author(
        action('A1', [
          { type: 'create', block: { id: 'W', parent: 'root', role: 'quote' }, predecessor: null },
        ]),
      ),
      deliver('A', 'B', ['A1']),
      author(
        action(
          'B1',
          [{ type: 'create', block: paragraph('N', 'n', 'W'), predecessor: null }],
          ['A1'],
          2n,
        ),
      ),
      deliver('B', 'A', ['B1']),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['B1'],
          3n,
        ),
      ),
      deliver('A', 'C', ['A1', 'A2']),
      deliver('B', 'C', ['B1']),
      expect('C', {
        rawParents: { root: null, W: 'root', N: 'W' },
        visible: { N: ['N0'] },
        hidden: [],
        deletedNodes: [],
        view: [
          { id: 'W', parent: 'root', kind: 'block-quote' },
          { id: 'N', parent: 'W', kind: 'paragraph' },
        ],
      }),
    ],
    [root],
  ),
  trace(
    'redo-old-move-keeps-old-priority',
    ['7.4'],
    'Reactivating A move does not outrank the newer B move; no-effect undo still consumes A own group.',
    [
      author(
        action('A1', [
          { type: 'move', node: 'P', parent: 'U', predecessor: null, standaloneFlow: 'fP' },
        ]),
      ),
      author(
        action('B1', [
          { type: 'move', node: 'P', parent: 'V', predecessor: null, standaloneFlow: 'fP' },
        ]),
      ),
      deliver('B', 'A', ['B1']),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['A1', 'B1'],
          2n,
        ),
      ),
      expect('A', {
        undo: [],
        redo: ['A1'],
        rawParents: { root: null, P: 'V', U: 'root', V: 'root' },
      }),
      author(
        action(
          'A3',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: true, previous: 'A2' }],
          ['A2'],
          3n,
        ),
      ),
      expect('A', {
        undo: ['A1'],
        redo: [],
        rawParents: { root: null, P: 'V', U: 'root', V: 'root' },
      }),
    ],
    [
      root,
      p,
      { id: 'U', parent: 'root', role: 'quote' },
      { id: 'V', parent: 'root', role: 'quote' },
    ],
  ),
  trace(
    'losing-interpretation-restores-only-own-mask',
    ['8.1'],
    'A later incompatible packet replaces the entire old packet and its exact syntax mask.',
    [
      ...concurrent(
        action('A1', [
          {
            type: 'interpret',
            packet: 'heading',
            source: 'P',
            presentation: 'section',
            mask: ['P0', 'P1'],
            wrappers: [],
          },
        ]),
        action('B1', [
          {
            type: 'interpret',
            packet: 'code',
            source: 'P',
            presentation: 'code',
            mask: [],
            wrappers: [],
          },
        ]),
        {
          activePackets: ['code'],
          nativeText: { P0: '#', P1: ' ', P2: 'x' },
          visible: { P: ['P0', 'P1', 'P2'] },
          hidden: [],
          view: [{ id: 'P', parent: 'root', kind: 'code-block' }],
        },
      ),
    ],
    [root, paragraph('P', '# x')],
  ),
  trace(
    'joined-interpretation-keeps-lineage-mask',
    ['8.1'],
    'Joining a converted flow retains its own consumed-prefix mask without masking destination text.',
    [
      author(
        action('A1', [
          {
            type: 'interpret',
            packet: 'heading',
            source: 'Q',
            presentation: 'section',
            mask: ['Q0', 'Q1'],
            wrappers: [],
          },
        ]),
      ),
      author(action('A2', [{ type: 'join', source: 'fQ', destinationSlot: 'P:end' }], ['A1'], 2n)),
      expect('A', {
        activePackets: ['heading'],
        hidden: ['Q0', 'Q1'],
        visible: { P: [...ids, 'Q2'] },
        flowParents: { fP: 'block:P', fQ: 'flow:fP@P:end' },
        markdown: 'abcdefx\n',
      }),
    ],
    [root, p, paragraph('Q', '# x')],
  ),
  trace(
    'normalized-wrapper-addresses',
    ['8.2'],
    'Adjacent wrappers project as one group with existing origins; normalization authors no action.',
    [
      expect('A', {
        rawParents: { root: null, U: 'root', P: 'U', V: 'root', Q: 'V' },
        view: [
          { id: 'U', parent: 'root', kind: 'block-quote' },
          { id: 'P', parent: 'U', kind: 'paragraph' },
          { id: 'Q', parent: 'U', kind: 'paragraph' },
        ],
        addresses: {
          U: { type: 'group', representative: 'U', constituents: ['U', 'V'] },
          'Q:start': { type: 'slot', run: 'rQ', slot: 'Q:start' },
        },
        emittedActions: [],
        held: [],
        heads: [],
      }),
    ],
    [
      root,
      { id: 'U', parent: 'root', role: 'quote' },
      paragraph('P', 'a', 'U'),
      { id: 'V', parent: 'root', role: 'quote' },
      paragraph('Q', 'b', 'V'),
    ],
  ),
  trace(
    'empty-root-creates-two-independent-paragraphs',
    ['8.2'],
    'Post-deletion caret views allocate nothing; independent edits explicitly create two paragraphs.',
    [
      author(action('A1', [deletion()])),
      deliver('A', 'B', ['A1']),
      deliver('A', 'C', ['A1']),
      expect('C', {
        visible: {},
        view: [],
        emittedActions: [],
        addresses: { caret: { type: 'empty-root', parent: 'root', predecessor: null } },
      }),
      author(
        action(
          'A2',
          [{ type: 'create', block: paragraph('N', 'a'), predecessor: null }],
          ['A1'],
          2n,
        ),
      ),
      author(
        action(
          'B1',
          [{ type: 'create', block: paragraph('M', 'b'), predecessor: null }],
          ['A1'],
          2n,
        ),
      ),
      deliver('A', 'C', ['A2']),
      deliver('B', 'C', ['B1']),
      expect('C', {
        rawParents: { root: null, P: 'root', N: 'root', M: 'root' },
        visible: { M: ['M0'], N: ['N0'] },
        deletedNodes: ['P'],
        view: [
          { id: 'M', parent: 'root', kind: 'paragraph' },
          { id: 'N', parent: 'root', kind: 'paragraph' },
        ],
        markdown: 'b\n\na\n',
        genesis: 'G',
      }),
    ],
  ),
];

export const operationalCorpus: readonly ContractTrace[] = [
  trace(
    'unready-branch-independent-progress',
    ['4.2'],
    'A complete dependent envelope waits while an unrelated ready branch remains editable.',
    [
      author(action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }])),
      author(
        action(
          'A2',
          [{ type: 'insert', cell: 'AY', text: 'y', tape: 'tP', slot: 'P:end' }],
          ['A1'],
          2n,
        ),
      ),
      author(
        action('B1', [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:start' }]),
      ),
      deliver('A', 'C', ['A2']),
      deliver('B', 'C', ['B1']),
      expect('C', {
        held: ['B1', 'A2'],
        ready: ['B1'],
        pending: ['A2'],
        nativeText: { ...text, BZ: 'z' },
        visible: { P: ['BZ', ...ids] },
        heads: ['B1'],
      }),
      deliver('A', 'C', ['A1']),
      expect('C', {
        ready: ['A1', 'B1', 'A2'],
        pending: [],
        nativeText: { ...text, AX: 'x', AY: 'y', BZ: 'z' },
        visible: { P: ['BZ', ...ids, 'AX', 'AY'] },
        heads: ['B1', 'A2'],
      }),
    ],
  ),
  trace(
    'outbound-only-undo-and-catch-up',
    ['7.4', '9.2'],
    'Outbound-only A undoes without seeing B; C receives the control before prerequisites; later catch-up preserves A live history.',
    [
      { type: 'mode', peer: 'A', mode: 'outbound-only' },
      author(action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }])),
      author(
        action('B1', [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:start' }]),
      ),
      deliver('A', 'B', ['A1']),
      ...(['peer', 'catch-up', 'self-echo', 'cross-tab'] as const).map(
        (route) => ({ type: 'deliver', from: 'B', to: 'A', actions: ['B1'], route }) as const,
      ),
      expect('A', {
        held: ['A1'],
        heads: ['A1'],
        nativeText: { ...text, AX: 'x' },
        visible: { P: [...ids, 'AX'] },
        undo: ['A1'],
        redo: [],
      }),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['A1'],
          2n,
        ),
      ),
      deliver('A', 'C', ['A2']),
      expect('C', { held: ['A2'], ready: [], pending: ['A2'], nativeText: text }),
      deliver('A', 'C', ['A1']),
      deliver('A', 'B', ['A2']),
      expect('B', { visible: { P: ['BZ', ...ids] }, undo: ['B1'], redo: [], hidden: ['AX'] }),
      expect('A', { held: ['A1', 'A2'], undo: [], redo: ['A1'], visible: { P: ids } }),
      { type: 'mode', peer: 'A', mode: 'bidirectional' },
      deliver('B', 'A', ['B1']),
      expect('A', {
        held: ['A1', 'B1', 'A2'],
        heads: ['B1', 'A2'],
        undo: [],
        redo: ['A1'],
        visible: { P: ['BZ', ...ids] },
        genesis: 'G',
      }),
      deliver('B', 'C', ['B1']),
      expect('C', { visible: { P: ['BZ', ...ids] }, undo: [], redo: [] }),
    ],
  ),
  trace(
    'strict-one-way-prerequisite-retransmission',
    ['9.2'],
    'A relay exports known B prerequisites to C without reverse acknowledgments or actor filtering.',
    [
      author(
        action('B1', [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:start' }]),
      ),
      deliver('B', 'A', ['B1']),
      { type: 'mode', peer: 'A', mode: 'outbound-only' },
      author(
        action(
          'A1',
          [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }],
          ['B1'],
          2n,
        ),
      ),
      deliver('A', 'C', ['A1']),
      expect('C', { pending: ['A1'], ready: [], nativeText: text }),
      deliver('A', 'C', ['B1', 'A1']),
      deliver('A', 'C', ['B1', 'A1']),
      expect('C', {
        held: ['B1', 'A1'],
        ready: ['B1', 'A1'],
        pending: [],
        visible: { P: ['BZ', ...ids, 'AX'] },
        undo: [],
        redo: [],
        heads: ['A1'],
      }),
      expect('A', { undo: ['A1'], redo: [], heads: ['A1'] }),
    ],
  ),
  trace(
    'inbound-only-edit-permission-is-separate',
    ['9.2'],
    'Host-authorized local edits persist without sending until the direction is enabled.',
    [
      { type: 'mode', peer: 'A', mode: 'inbound-only' },
      author(action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }])),
      deliver('A', 'B', ['A1']),
      expect('B', { held: [], visible: { P: ids } }),
      author(
        action('B1', [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:start' }]),
      ),
      deliver('B', 'A', ['B1']),
      expect('A', { held: ['A1', 'B1'], visible: { P: ['BZ', ...ids, 'AX'] }, undo: ['A1'] }),
      { type: 'mode', peer: 'A', mode: 'disconnected' },
      deliver('B', 'A', ['B1']),
      expect('A', { held: ['A1', 'B1'], undo: ['A1'] }),
      { type: 'mode', peer: 'A', mode: 'bidirectional' },
      deliver('A', 'B', ['A1']),
      expect('B', { held: ['A1', 'B1'], visible: { P: ['BZ', ...ids, 'AX'] }, undo: ['B1'] }),
    ],
  ),
  trace(
    'remote-control-does-not-clear-peer-redo',
    ['7.4'],
    'Separate instances for the same account retain independent navigation stacks.',
    [
      author(action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }])),
      author(
        action('B1', [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:start' }]),
      ),
      author(
        action(
          'B2',
          [{ type: 'control', group: 'B1', actions: ['B1'], active: false, previous: null }],
          ['B1'],
          2n,
        ),
      ),
      deliver('A', 'B', ['A1']),
      expect('B', { undo: [], redo: ['B1'] }),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['A1'],
          2n,
        ),
      ),
      deliver('A', 'B', ['A2']),
      expect('B', { undo: [], redo: ['B1'], visible: { P: ids } }),
      { type: 'mode', peer: 'B', mode: 'disconnected' },
      expect('B', { undo: [], redo: ['B1'] }),
      { type: 'restart', peer: 'B' },
      expect('B', {
        undo: [],
        redo: [],
        held: ['A1', 'B1', 'A2', 'B2'],
        visible: { P: ids },
        genesis: 'G',
      }),
    ],
  ),
  trace(
    'old-prefix-after-lossless-maintenance',
    ['10.2', '10.3'],
    'History eviction, cache eviction and checkpoint reload retain canonical facts for an indefinitely old writer.',
    [
      { type: 'mode', peer: 'A', mode: 'disconnected' },
      author(action('B1', [{ type: 'delete-text', tag: 'dB', cells: ['P2'] }])),
      author(
        action(
          'B2',
          [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:end' }],
          ['B1'],
          2n,
        ),
      ),
      { type: 'maintain', peer: 'B', operation: 'evict-history' },
      { type: 'maintain', peer: 'B', operation: 'drop-caches' },
      { type: 'maintain', peer: 'B', operation: 'checkpoint-reload' },
      expect('B', {
        retainedActions: ['B1', 'B2'],
        nativeText: { ...text, BZ: 'z' },
        hidden: ['P2'],
        undo: [],
        redo: [],
        genesis: 'G',
      }),
      author(
        action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:after-c' }]),
      ),
      { type: 'mode', peer: 'A', mode: 'bidirectional' },
      deliver('A', 'B', ['A1']),
      deliver('B', 'A', ['B1', 'B2']),
      expect('B', {
        retainedActions: ['A1', 'B1', 'B2'],
        hidden: ['P2'],
        visible: { P: ['P0', 'P1', 'AX', 'P3', 'P4', 'P5', 'BZ'] },
        genesis: 'G',
      }),
      expect('A', {
        visible: { P: ['P0', 'P1', 'AX', 'P3', 'P4', 'P5', 'BZ'] },
        undo: ['A1'],
        genesis: 'G',
      }),
    ],
  ),
];

export const layoutCorpus: readonly ContractTrace[] = [
  trace(
    'split-inside-cross-tape-join',
    ['6.6'],
    'A split can extract a suffix of a nested joined flow with no new character identities.',
    [
      author(action('A1', [{ type: 'join', source: 'fQ', destinationSlot: 'P:end' }])),
      author(
        action(
          'A2',
          [
            {
              type: 'split',
              source: 'Q',
              basis: ['Q0', 'Q1'],
              after: 'Q0',
              marker: 'cut:S',
              retainedSide: 'left',
              node: 'S',
              flow: 'fS',
              run: 'rS',
              parent: 'root',
              predecessor: 'P:birth',
            },
          ],
          ['A1'],
          2n,
        ),
      ),
      expect('A', {
        rawParents: { root: null, P: 'root', Q: 'root', S: 'root' },
        flowParents: { fP: 'block:P', fQ: 'flow:fP@P:end', fS: 'block:S' },
        cellRuns: { ...base.cellRuns, Q0: 'rQ', Q1: 'rS' },
        nativeText: { ...text, Q0: 'X', Q1: 'Y' },
        visible: { P: [...ids, 'Q0'], S: ['Q1'] },
        view: [...base.view, { id: 'S', parent: 'root', kind: 'paragraph' }],
        markdown: 'abcdefX\n\nY\n',
      }),
    ],
    [root, p, q],
  ),
  trace(
    'move-overrides-join',
    ['5.2'],
    'A later inline move asserts standalone flow placement and prevents duplicate rendering.',
    concurrent(
      action('A1', [{ type: 'join', source: 'fQ', destinationSlot: 'P:end' }]),
      action('B1', [
        { type: 'move', node: 'Q', parent: 'root', predecessor: null, standaloneFlow: 'fQ' },
      ]),
      {
        rawParents: { root: null, P: 'root', Q: 'root' },
        flowParents: { fP: 'block:P', fQ: 'block:Q' },
        visible: { Q: ['Q0', 'Q1'], P: ids },
        view: [{ id: 'Q', parent: 'root', kind: 'paragraph' }, ...base.view],
        markdown: 'XY\n\nabcdef\n',
      },
    ),
    [root, p, q],
  ),
  trace(
    'overlapping-transfers',
    ['6.4'],
    'Overlapping cells take the later run; untouched cells keep their earlier owner.',
    concurrent(
      action('A1', [
        { type: 'transfer', cells: ['P1', 'P2', 'P3'], destinationSlot: 'Q:end', run: 'rA' },
      ]),
      action('B1', [
        { type: 'transfer', cells: ['P2', 'P3', 'P4'], destinationSlot: 'R:end', run: 'rB' },
      ]),
      {
        cellRuns: {
          P0: 'rP',
          P1: 'rA',
          P2: 'rB',
          P3: 'rB',
          P4: 'rB',
          P5: 'rP',
          Q0: 'rQ',
          Q1: 'rQ',
          R0: 'rR',
        },
        runFlows: { rP: 'fP', rQ: 'fQ', rR: 'fR', rA: 'fQ', rB: 'fR' },
        visible: { P: ['P0', 'P5'], Q: ['Q0', 'Q1', 'P1'], R: ['R0', 'P2', 'P3', 'P4'] },
        slots: { ...base.slots, 'Q:start': 'rQ', 'Q:end': 'rQ', 'R:start': 'rR', 'R:end': 'rR' },
        markdown: 'af\n\nXYb\n\nZcde\n',
      },
    ),
    [root, p, q, paragraph('R', 'Z')],
  ),
  trace(
    'ghost-destination-slot',
    ['5.1', '6.4'],
    'Moving destination cells does not destroy their old run slot as an insertion address.',
    [
      author(
        action('A1', [
          { type: 'transfer', cells: ['Q0', 'Q1'], destinationSlot: 'P:end', run: 'rA' },
        ]),
      ),
      author(
        action(
          'A2',
          [{ type: 'transfer', cells: ['P0'], destinationSlot: 'Q:end', run: 'rB' }],
          ['A1'],
          2n,
        ),
      ),
      expect('A', {
        cellRuns: {
          P0: 'rB',
          P1: 'rP',
          P2: 'rP',
          P3: 'rP',
          P4: 'rP',
          P5: 'rP',
          Q0: 'rA',
          Q1: 'rA',
        },
        runFlows: { rP: 'fP', rQ: 'fQ', rA: 'fP', rB: 'fQ' },
        skeletons: { rP: ids, rQ: ['Q0', 'Q1'], rA: ['Q0', 'Q1'], rB: ['P0'] },
        slots: { ...base.slots, 'Q:start': 'rQ', 'Q:end': 'rQ' },
        visible: { P: ['P1', 'P2', 'P3', 'P4', 'P5', 'Q0', 'Q1'], Q: ['P0'] },
        markdown: 'bcdefXY\n\na\n',
      }),
    ],
    [root, p, q],
  ),
  trace(
    'shared-empty-genesis',
    ['8.2'],
    'Initial typing addresses one common paragraph and lineage rather than independent parse results.',
    concurrent(
      action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:start' }]),
      action('B1', [{ type: 'insert', cell: 'BY', text: 'y', tape: 'tP', slot: 'P:start' }]),
      {
        rawParents: { root: null, P: 'root' },
        flowParents: { fP: 'block:P' },
        runFlows: { rP: 'fP' },
        cellRuns: { AX: 'rP', BY: 'rP' },
        nativeText: { AX: 'x', BY: 'y' },
        slots: { 'P:start': 'rP', 'P:end': 'rP' },
        visible: { P: ['AX', 'BY'] },
        view: base.view,
        markdown: 'xy\n',
        genesis: 'G',
      },
    ),
    [root, paragraph('P', '')],
  ),
];

const retainedGroupIds = Array.from({ length: 501 }, (_, index) => `B${index + 1}`);
const retentionActions = retainedGroupIds.map((id, index) =>
  action(
    id,
    [
      {
        type: 'insert',
        cell: `BX${index + 1}`,
        text: 'x',
        tape: 'tP',
        slot: 'P:end',
      },
    ],
    index === 0 ? [] : [`B${index}`],
    BigInt(index + 1),
  ),
);
export const historyLimitTrace: ContractTrace = trace(
  'history-limit-retains-canonical-facts',
  ['7.4', '10.2'],
  'The 501st group evicts only navigation metadata; an old-prefix writer can still address the original tape after checkpoint reload.',
  [
    ...retentionActions.map(author),
    expect('B', {
      undo: retainedGroupIds.slice(1),
      redo: [],
      retainedActions: retainedGroupIds,
      genesis: 'G',
    }),
    { type: 'maintain', peer: 'B', operation: 'drop-caches' },
    { type: 'maintain', peer: 'B', operation: 'checkpoint-reload' },
    expect('B', {
      retainedActions: retainedGroupIds,
      genesis: 'G',
      nativeText: {
        ...text,
        ...Object.fromEntries(retainedGroupIds.map((_, index) => [`BX${index + 1}`, 'x'])),
      },
    }),
    author(
      action('A1', [{ type: 'insert', cell: 'AX', text: 'z', tape: 'tP', slot: 'P:after-b' }]),
    ),
    deliver('A', 'B', ['A1']),
    expect('B', {
      retainedActions: ['A1', ...retainedGroupIds],
      genesis: 'G',
      visible: {
        P: [
          'P0',
          'P1',
          'AX',
          'P2',
          'P3',
          'P4',
          'P5',
          ...retainedGroupIds.map((_, index) => `BX${index + 1}`),
        ],
      },
    }),
  ],
);

export const ingestCorpus: readonly ContractTrace[] = [
  trace(
    'fork-quarantines-materialized-dependents',
    ['4.1', '4.3', '10.1'],
    'Both payloads remain observable; a fork quarantines its descendants and rebuilds the contaminated native cache.',
    [
      author(action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }])),
      author(
        action(
          'A2',
          [{ type: 'insert', cell: 'AY', text: 'y', tape: 'tP', slot: 'P:end' }],
          ['A1'],
          2n,
        ),
      ),
      deliver('A', 'C', ['A1', 'A2']),
      expect('C', {
        ready: ['A1', 'A2'],
        nativeText: { ...text, AX: 'x', AY: 'y' },
        visible: { P: [...ids, 'AX', 'AY'] },
      }),
      author(
        action('B1', [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:start' }]),
      ),
      deliver('B', 'C', ['B1']),
      {
        type: 'deliver',
        from: 'A',
        to: 'C',
        actions: ['A1'],
        route: 'peer',
        mutation: { action: 'A1', type: 'fork-payload' },
      },
      expect('C', {
        held: ['A1', 'B1', 'A2'],
        ready: ['B1'],
        quarantined: ['A1', 'A2'],
        pending: [],
        variants: { A1: 2, A2: 1, B1: 1 },
        nativeText: { ...text, BZ: 'z' },
        visible: { P: ['BZ', ...ids] },
        heads: ['B1'],
      }),
    ],
  ),
  ...(['unsupported-version', 'native-delete', 'unknown-resource'] as const).map((fault) =>
    trace(
      `reject-${fault}`,
      ['4.2', '10.1'],
      'An invalid envelope never contributes hidden native state to authoring; an independent valid branch still progresses.',
      [
        author(
          action('A1', [{ type: 'insert', cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }]),
        ),
        author(
          action('B1', [{ type: 'insert', cell: 'BZ', text: 'z', tape: 'tP', slot: 'P:start' }]),
        ),
        {
          type: 'deliver',
          from: 'A',
          to: 'C',
          actions: ['A1'],
          route: 'peer',
          mutation: { action: 'A1', type: fault },
        },
        deliver('B', 'C', ['B1']),
        expect('C', {
          held: ['A1', 'B1'],
          ready: ['B1'],
          quarantined: ['A1'],
          nativeText: { ...text, BZ: 'z' },
          visible: { P: ['BZ', ...ids] },
          heads: ['B1'],
        }),
      ],
    ),
  ),
];

export const compositionCorpus: readonly ContractTrace[] = [
  ...([false, true] as const).map((reverse) =>
    trace(
      `split-sibling-keeps-authored-outer-context${reverse ? '-reverse' : ''}`,
      ['5.1', '6.5'],
      'The split sibling stays after the moved predecessor’s ghost occurrence and before U in either semantic tie order.',
      concurrent(
        action(reverse ? 'B1' : 'A1', [
          { type: 'move', node: 'P', parent: 'U', predecessor: null, standaloneFlow: 'fP' },
        ]),
        action(reverse ? 'A1' : 'B1', [split('S', 'P2')]),
        {
          rawParents: { root: null, U: 'root', P: 'U', S: 'root' },
          flowParents: { fP: 'block:P', fS: 'block:S' },
          visible: { P: ['P0', 'P1', 'P2'], S: ['P3', 'P4', 'P5'] },
          view: [
            { id: 'S', parent: 'root', kind: 'paragraph' },
            { id: 'U', parent: 'root', kind: 'block-quote' },
            { id: 'P', parent: 'U', kind: 'paragraph' },
          ],
        },
      ),
      [root, p, { id: 'U', parent: 'root', role: 'quote' }],
    ),
  ),
  trace(
    'undo-cross-tape-join',
    ['6.6', '7.4'],
    'Retracting a join detaches the existing flow and restores its original header without copying.',
    [
      author(action('A1', [{ type: 'join', source: 'fQ', destinationSlot: 'P:end' }])),
      expect('A', {
        flowParents: { fP: 'block:P', fQ: 'flow:fP@P:end' },
        visible: { P: [...ids, 'Q0', 'Q1'] },
      }),
      author(
        action(
          'A2',
          [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
          ['A1'],
          2n,
        ),
      ),
      expect('A', {
        rawParents: { root: null, P: 'root', Q: 'root' },
        flowParents: { fP: 'block:P', fQ: 'block:Q' },
        nativeText: { ...text, Q0: 'X', Q1: 'Y' },
        cellRuns: { ...base.cellRuns, Q0: 'rQ', Q1: 'rQ' },
        visible: { P: ids, Q: ['Q0', 'Q1'] },
        view: [...base.view, { id: 'Q', parent: 'root', kind: 'paragraph' }],
        undo: [],
        redo: ['A1'],
      }),
    ],
    [root, p, q],
  ),
  trace(
    'outbound-structural-sequence-versus-unseen-delete',
    ['9.2', '7.3'],
    'An outbound-only author continues split, join, move and interpretation while B independently deletes the source.',
    [
      { type: 'mode', peer: 'A', mode: 'outbound-only' },
      author(action('B1', [deletion()])),
      author(action('A1', [split('S', 'P2')])),
      author(action('A2', [{ type: 'join', source: 'fS', destinationSlot: 'P:end' }], ['A1'], 2n)),
      author(
        action(
          'A3',
          [
            {
              type: 'move',
              node: 'P',
              parent: 'root',
              predecessor: 'Q:birth',
              standaloneFlow: 'fP',
            },
          ],
          ['A2'],
          3n,
        ),
      ),
      author(
        action(
          'A4',
          [
            {
              type: 'interpret',
              packet: 'heading',
              source: 'P',
              presentation: 'section',
              mask: [],
              wrappers: [],
            },
          ],
          ['A3'],
          4n,
        ),
      ),
      deliver('B', 'A', ['B1']),
      expect('A', {
        held: ['A1', 'A2', 'A3', 'A4'],
        heads: ['A4'],
        undo: ['A1', 'A2', 'A3', 'A4'],
        visible: { Q: ['Q0', 'Q1'], P: ids },
        hidden: [],
        activePackets: ['heading'],
        view: [
          { id: 'Q', parent: 'root', kind: 'paragraph' },
          { id: 'P', parent: 'root', kind: 'section' },
        ],
      }),
      deliver('A', 'B', ['A4', 'A3', 'A2', 'A1']),
      expect('B', {
        held: ['A1', 'B1', 'A2', 'A3', 'A4'],
        ready: ['A1', 'B1', 'A2', 'A3', 'A4'],
        pending: [],
        visible: { Q: ['Q0', 'Q1'] },
        hidden: ids,
        deletedNodes: ['P'],
        undo: ['B1'],
        view: [{ id: 'Q', parent: 'root', kind: 'paragraph' }],
        markdown: 'XY\n',
      }),
    ],
    [root, p, q],
  ),
];

export const contractCorpus: readonly ContractTrace[] = [
  ...semanticCorpus,
  ...deletionAndProjectionCorpus,
  ...layoutCorpus,
  ...operationalCorpus,
  historyLimitTrace,
  ...ingestCorpus,
  ...compositionCorpus,
];
