// @ts-expect-error Node APIs are supplied by Vitest; Grain has no @types/node dependency.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contractCorpus } from '../../../test/multiwriter/corpus.js';
import { compatibilityInventory } from '../../../test/multiwriter/compatibility.js';
import { runContractTrace } from '../../../test/multiwriter/trace.js';
import type {
  ContractTrace,
  Observation,
  TraceAction,
  TraceAdapter,
} from '../../../test/multiwriter/trace.js';
import { SYNC_DIRECTIONS, YJS_VERSION } from './contracts.js';

function closure(
  id: string,
  actions: ReadonlyMap<string, TraceAction>,
  result = new Set<string>(),
): Set<string> {
  if (result.has(id)) return result;
  const action = actions.get(id);
  if (!action) throw new Error(`Unknown dependency ${id}`);
  result.add(id);
  for (const dependency of action.dependencies) closure(dependency, actions, result);
  return result;
}
function ordered(ids: Iterable<string>, actions: ReadonlyMap<string, TraceAction>): string[] {
  return [...ids].sort((a, b) => {
    const left = actions.get(a)!;
    const right = actions.get(b)!;
    return left.lamport < right.lamport
      ? -1
      : left.lamport > right.lamport
        ? 1
        : a < b
          ? -1
          : a > b
            ? 1
            : 0;
  });
}

it('keeps trace IDs unique and freezes the version and three independent peers', () => {
  expect(new Set(contractCorpus.map((trace) => trace.id)).size).toBe(contractCorpus.length);
  for (const trace of contractCorpus) {
    expect(trace.version).toBe(3);
    expect(trace.genesis).toBe('G');
    expect(trace.peers).toEqual(['A', 'B', 'C']);
    expect(trace.sections.length).toBeGreaterThan(0);
    expect(trace.steps.some((step) => step.type === 'expect')).toBe(true);
  }
});

// Restricted occurrence-order check for §§5.1/6.5, not an engine acceptance gate.
// Import actual fixtures so this catches a wrong frozen expectation.
describe('split after a moved predecessor', () => {
  const traces = contractCorpus.filter((trace) =>
    trace.id.startsWith('split-sibling-keeps-authored-outer-context'),
  );
  it('covers both semantic tie orders', () => {
    expect(
      traces.map((trace) =>
        trace.steps
          .filter((step) => step.type === 'author')
          .map((step) => [step.action.peer, step.action.intents[0].type]),
      ),
    ).toEqual([
      [
        ['A', 'move'],
        ['B', 'split'],
      ],
      [
        ['B', 'move'],
        ['A', 'split'],
      ],
    ]);
  });
  for (const shape of ['chained', 'siblings'] as const)
    for (const reverseDelivery of [false, true])
      it.each(traces)(
        `$id retains the ghost anchor (${shape}, reversed=${reverseDelivery})`,
        (trace) => {
          type Occurrence = {
            id: string;
            node: string;
            parent: string;
            predecessor: string | null;
            rank: number;
          };
          const occurrences: Occurrence[] = [];
          const active = new Map<string, string>();
          const roles = new Map(trace.seed.map((block) => [block.id, block.role]));
          for (const [index, block] of trace.seed.entries()) {
            if (block.parent === null) continue;
            const previous = trace.seed.slice(0, index).findLast((b) => b.parent === block.parent);
            const id = `${block.id}:birth`;
            occurrences.push({
              id,
              node: block.id,
              parent: block.parent,
              predecessor: shape === 'chained' && previous ? `${previous.id}:birth` : null,
              rank: -index,
            });
            active.set(block.id, id);
          }
          function ordered(parent: string, predecessor: string | null = null): Occurrence[] {
            return occurrences
              .filter((o) => o.parent === parent && o.predecessor === predecessor)
              .sort((a, b) => b.rank - a.rank)
              .flatMap((o) => [o, ...ordered(parent, o.id)]);
          }
          function view(parent = 'root'): Observation['view'] {
            return ordered(parent)
              .filter((o) => active.get(o.node) === o.id)
              .flatMap((o) => [
                {
                  id: o.node,
                  parent,
                  kind: roles.get(o.node) === 'quote' ? 'block-quote' : 'paragraph',
                },
                ...view(o.node),
              ]);
          }
          expect(view().map((node) => node.id)).toEqual(['P', 'U']);
          const authors = trace.steps
            .filter((step) => step.type === 'author')
            .map((step) => step.action);
          if (reverseDelivery) authors.reverse();
          for (const action of authors) {
            expect(action.lamport).toBe(1n);
            for (const intent of action.intents) {
              if (intent.type !== 'move' && intent.type !== 'split')
                throw new Error('Unexpected intent');
              if (intent.type === 'split') {
                expect(intent.parent).toBe('root');
                expect(intent.predecessor).toBe('P:birth');
                roles.set(intent.node, 'inline');
              }
              const id = `${action.id}:${intent.type}`;
              occurrences.push({
                id,
                node: intent.node,
                parent: intent.parent,
                predecessor: intent.predecessor,
                rank: trace.peers.indexOf(action.peer as 'A' | 'B' | 'C') + 1,
              });
              active.set(intent.node, id);
            }
          }
          expect(occurrences.find((o) => o.id === 'P:birth')?.parent).toBe('root');
          expect(active.get('P')).not.toBe('P:birth');
          expect(view()).toEqual([
            { id: 'S', parent: 'root', kind: 'paragraph' },
            { id: 'U', parent: 'root', kind: 'block-quote' },
            { id: 'P', parent: 'U', kind: 'paragraph' },
          ]);
          for (const step of trace.steps)
            if (step.type === 'expect') expect(step.state.view).toEqual(view());
        },
      );
});

describe('authored trace audit (not a semantic reducer)', () => {
  it.each(contractCorpus)('$id uses valid actor chains and observed causal heads', (trace) => {
    const actions = new Map<string, TraceAction>();
    const held = new Map(trace.peers.map((peer) => [peer, new Set<string>()]));
    const modes = new Map(
      trace.peers.map((peer) => [peer, 'bidirectional' as keyof typeof SYNC_DIRECTIONS]),
    );
    const sequence = new Map<string, bigint>();
    for (const step of trace.steps) {
      if (step.type === 'mode') {
        modes.set(step.peer as 'A' | 'B' | 'C', step.mode);
        continue;
      }
      if (step.type === 'deliver') {
        for (const id of step.actions)
          expect(
            held.get(step.from as 'A' | 'B' | 'C')!.has(id),
            `${trace.id} ${step.from} cannot relay unknown ${id}`,
          ).toBe(true);
        if (
          SYNC_DIRECTIONS[modes.get(step.from as 'A' | 'B' | 'C')!].send &&
          SYNC_DIRECTIONS[modes.get(step.to as 'A' | 'B' | 'C')!].receive
        )
          for (const id of step.actions) held.get(step.to as 'A' | 'B' | 'C')!.add(id);
        continue;
      }
      if (step.type !== 'author') continue;
      const action = step.action;
      expect(actions.has(action.id)).toBe(false);
      expect(action.sequence).toBe((sequence.get(action.peer) ?? 0n) + 1n);
      expect(action.id).toBe(`${action.peer}${action.sequence}`);
      for (const dependency of action.dependencies)
        expect(held.get(action.peer as 'A' | 'B' | 'C')!.has(dependency)).toBe(true);
      const dependencyClosure = new Set(
        action.dependencies.flatMap((id) => [...closure(id, actions)]),
      );
      const previous = sequence.get(action.peer);
      if (previous)
        expect(dependencyClosure.has(`${action.peer}${previous}`), `${trace.id} own chain`).toBe(
          true,
        );
      const readyHeld = [...held.get(action.peer as 'A' | 'B' | 'C')!].filter(
        (id) =>
          actions.get(id)!.peer === action.peer ||
          [...closure(id, actions)].every((d) => held.get(action.peer as 'A' | 'B' | 'C')!.has(d)),
      );
      for (const known of readyHeld)
        expect(dependencyClosure.has(known), `${trace.id} ${action.id} must observe ${known}`).toBe(
          true,
        );
      const maximum = action.dependencies.reduce(
        (value, id) => (actions.get(id)!.lamport > value ? actions.get(id)!.lamport : value),
        0n,
      );
      expect(action.lamport).toBe(maximum + 1n);
      for (const intent of action.intents)
        if (intent.type === 'control') {
          for (const target of intent.actions) {
            expect(actions.get(target)!.peer).toBe(action.peer);
            expect(actions.get(target)!.group).toBe(intent.group);
            expect(dependencyClosure.has(target)).toBe(true);
          }
          if (intent.previous) expect(dependencyClosure.has(intent.previous)).toBe(true);
        }
      actions.set(action.id, action);
      held.get(action.peer as 'A' | 'B' | 'C')!.add(action.id);
      sequence.set(action.peer, action.sequence);
    }
  });
  it.each(contractCorpus)(
    '$id expected states preserve exclusive visible identities and known native aliases',
    (trace) => {
      const aliases = new Set(
        trace.seed.flatMap((block) => (block.cells ?? []).map((cell) => cell.id)),
      );
      const actions = new Map<string, TraceAction>();
      for (const step of trace.steps) {
        if (step.type === 'author') {
          actions.set(step.action.id, step.action);
          for (const intent of step.action.intents) {
            if (intent.type === 'insert') aliases.add(intent.cell);
            if (intent.type === 'create')
              for (const cell of intent.block.cells ?? []) aliases.add(cell.id);
          }
        }
        if (step.type !== 'expect') continue;
        const state = step.state;
        const visible = Object.values(state.visible ?? {}).flat();
        expect(new Set(visible).size).toBe(visible.length);
        for (const id of visible)
          expect(aliases.has(id), `${trace.id} unknown native alias ${id}`).toBe(true);
        for (const id of state.hidden ?? []) expect(visible).not.toContain(id);
        if (state.nativeText && state.cellRuns)
          expect(Object.keys(state.cellRuns).sort()).toEqual(Object.keys(state.nativeText).sort());
        for (const key of [
          'held',
          'ready',
          'pending',
          'quarantined',
          'heads',
          'retainedActions',
        ] as const)
          if (state[key]) {
            expect(new Set(state[key]).size).toBe(state[key]!.length);
            expect(state[key]).toEqual(ordered(state[key]!, actions));
          }
      }
    },
  );
});

const project = new URL('../../../', import.meta.url);
function testFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry: { name: string; isDirectory(): boolean }) => {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      return entry.isDirectory()
        ? testFiles(path)
        : entry.name.endsWith('.test.ts')
          ? [decodeURIComponent(path.pathname).slice(decodeURIComponent(project.pathname).length)]
          : [];
    },
  );
}
it('inventories every baseline suite and requires an explicit disposition before removal', () => {
  const inventory = Object.values(compatibilityInventory).flat();
  expect(new Set(inventory).size).toBe(inventory.length);
  for (const path of inventory)
    expect(existsSync(new URL(path, project)), `missing preserved suite ${path}`).toBe(true);
  expect(
    testFiles(new URL('src/', project))
      .filter(
        (path) =>
          !path.startsWith('src/markdown/multiwriter/') ||
          path.startsWith('src/markdown/multiwriter/providers/') ||
          path.startsWith('src/markdown/multiwriter/replica/'),
      )
      .sort(),
  ).toEqual([...inventory].sort());
  const manifest = JSON.parse(readFileSync(new URL('package.json', project), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', project), 'utf8'));
  expect(manifest.dependencies.yjs).toBe(YJS_VERSION);
  expect(lock.packages['node_modules/yjs'].version).toBe(YJS_VERSION);
});

/** These test the comparison harness only. No fake adapter is run as an engine acceptance gate. */
function observation(): Observation {
  return {
    nativeIds: { x: { client: 1, clock: 0, length: 1 } },
    resources: {
      run: { kind: 'run', birth: { type: 'genesis', genesisId: 'G' }, ordinal: 0 },
      root: { kind: 'node', birth: { type: 'genesis', genesisId: 'G' }, ordinal: 1 },
    },
    nativeText: { x: 'x' },
    held: [],
    ready: [],
    pending: [],
    quarantined: [],
    variants: {},
    heads: [],
    rawParents: { root: null },
    flowParents: {},
    runFlows: {},
    cellRuns: { x: 'run' },
    skeletons: { run: ['x'] },
    slots: {},
    visible: { P: ['x'] },
    hidden: [],
    deletedNodes: [],
    view: [],
    addresses: {},
    undo: [],
    redo: [],
    retainedActions: [],
    genesis: 'G',
    emittedActions: [],
    activePackets: [],
    markdown: 'x\n',
  };
}
const harnessTrace: ContractTrace = {
  version: 3,
  id: 'harness-control',
  sections: ['test-helper'],
  purpose: 'Test assertion and disposal behavior only',
  genesis: 'G',
  peers: ['A', 'B', 'C'],
  seed: [],
  steps: [
    { type: 'expect', peer: 'A', state: { visible: { P: ['x'] }, cellRuns: { x: 'run' } } },
    { type: 'expect', peer: 'B', state: { visible: { P: ['x'] } } },
  ],
};
const equal = (actual: unknown, expected: unknown, context: string) =>
  expect(actual, context).toEqual(expected);
function adapter(observe: TraceAdapter['observe']): TraceAdapter & { disposed: boolean } {
  return {
    disposed: false,
    initialize() {},
    execute() {},
    observe,
    dispose() {
      this.disposed = true;
    },
  };
}
it('compares selected facets at every checkpoint and disposes the adapter', async () => {
  const control = adapter(() => observation());
  await runContractTrace(control, harnessTrace, equal);
  expect(control.disposed).toBe(true);
});
it('rejects correct text with wrong ownership and disposes after failure', async () => {
  const wrong = adapter(() => ({
    ...observation(),
    cellRuns: { x: 'wrong-run' },
    resources: {
      ...observation().resources,
      'wrong-run': { kind: 'run', birth: { type: 'genesis', genesisId: 'G' }, ordinal: 2 },
    },
  }));
  await expect(runContractTrace(wrong, harnessTrace, equal)).rejects.toThrow('cellRuns');
  expect(wrong.disposed).toBe(true);
});
it('rejects fresh-copy identity substitution between peers', async () => {
  let reads = 0;
  const wrong = adapter(() => ({
    ...observation(),
    nativeIds: { x: { client: 1, clock: reads++, length: 1 } },
  }));
  await expect(runContractTrace(wrong, harnessTrace, equal)).rejects.toThrow(
    'retained native identity',
  );
});
it('rejects duplicate visible identities even when Markdown matches', async () => {
  const wrong = adapter(() => ({ ...observation(), visible: { P: ['x'], Q: ['x'] } }));
  await expect(runContractTrace(wrong, harnessTrace, equal)).rejects.toThrow(
    'visible identities occur once',
  );
});
it('rejects overlapping native ranges and UTF-16 length mismatches', async () => {
  const overlap = adapter(() => ({
    ...observation(),
    nativeText: { x: 'x', y: 'y' },
    cellRuns: { x: 'run', y: 'run' },
    nativeIds: { x: { client: 1, clock: 0, length: 1 }, y: { client: 1, clock: 0, length: 1 } },
  }));
  await expect(runContractTrace(overlap, harnessTrace, equal)).rejects.toThrow(
    'unique native range',
  );
  const mismatch = adapter(() => ({ ...observation(), nativeText: { x: '😀' } }));
  await expect(runContractTrace(mismatch, harnessTrace, equal)).rejects.toThrow('UTF-16 length');
});

it('rejects stable aliases that conceal replacement of a persistent resource', async () => {
  let ordinal = 0;
  const wrong = adapter(() => ({
    ...observation(),
    resources: {
      ...observation().resources,
      run: { kind: 'run', birth: { type: 'genesis', genesisId: 'G' }, ordinal: ordinal++ },
    },
  }));
  await expect(runContractTrace(wrong, harnessTrace, equal)).rejects.toThrow(
    'retained resource identity',
  );
});
