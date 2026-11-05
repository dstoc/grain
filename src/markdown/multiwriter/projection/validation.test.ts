import { afterEach, expect, test } from 'vitest';
import type { ActionEnvelope, Allocation, SemanticEffect } from '../contracts.js';
import { ActionStore } from '../actions/store.js';
import { createIngestValidator } from '../ingest/index.js';
import { nativeView } from '../ingest/publication.js';
import { action as emptyAction } from '../actions/test-fixtures.js';
import type { AuthorValidationContext } from '../ingest/validator.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { resourceKey } from '../layout/index.js';
import { createProjectionAuthorValidator } from './index.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    ...['P', 'Q'].map((id) => ({
      id,
      parent: 'root',
      role: 'inline' as const,
      flow: `f${id}`,
      run: `r${id}`,
      tape: `t${id}`,
      cells: [...'# x😀'].map((text, i) => ({ id: `${id}${i}`, text })),
    })),
  ]);
  cleanup.push(() => f.destroy());
  return f;
}
function interpret(f: NativeFixture, source = 'P'): SemanticEffect {
  return {
    type: 'Interpret',
    packet: {
      id: f.allocate('heading', 'interpretation'),
      source: f.id(source, 'node'),
      properties: { presentation: 'section', marker: '#', info: null },
      wrappers: [],
      placements: [],
      syntaxMask: [f.aliases.get(`${source}0`)!, f.aliases.get(`${source}1`)!],
      synthesizedText: [],
    },
  };
}
function author(
  f: NativeFixture,
  name: string,
  build: (f: NativeFixture) => readonly SemanticEffect[],
  dependencies: readonly string[] = [],
  lamport = 1n,
) {
  const entry = f.author(name, build, dependencies, lamport);
  const allocations: Allocation[] = entry.action.effects.flatMap((effect) =>
    effect.type === 'Interpret' ? [{ type: 'interpretation', id: effect.packet.id }] : [],
  );
  f.actions.set(name, {
    ...entry,
    action: { ...entry.action, allocations: [...entry.action.allocations, ...allocations] },
  });
  return f.envelope(name);
}
function store(f: NativeFixture) {
  const validate = createIngestValidator({
    genesis: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    validateAuthor: createProjectionAuthorValidator({
      genesis: f.genesis,
      births: (action) =>
        [...f.actions.values()].find(
          (entry) =>
            entry.action.id.actor === action.id.actor &&
            entry.action.id.sequence === action.id.sequence,
        )!.births,
    }),
  });
  const store = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: f.genesis.allocations,
    validate,
  });
  cleanup.push(() => {
    store.destroy();
    validate.destroy();
  });
  return store;
}
function packet(action: ActionEnvelope) {
  const effect = action.effects.find((effect) => effect.type === 'Interpret');
  if (!effect || effect.type !== 'Interpret') throw new Error();
  return effect.packet;
}
function withPacket(
  action: ActionEnvelope,
  change: Partial<ReturnType<typeof packet>>,
): ActionEnvelope {
  let changed = false;
  return {
    ...action,
    effects: action.effects.map((effect) => {
      if (effect.type !== 'Interpret' || changed) return effect;
      changed = true;
      return { ...effect, packet: { ...effect.packet, ...change } };
    }),
  };
}

test('accepts a real exact-author heading through ActionStore/MW-15 and quarantines wrong native lineage', () => {
  const f = fixture();
  const action = author(f, 'A1', (f) => [interpret(f)]);
  const accepted = store(f);
  accepted.append(action);
  expect(accepted.snapshot().ready.map((action) => action.id)).toEqual([action.id]);
  for (const invalid of [
    withPacket(action, { source: f.id('Q', 'node') }),
    withPacket(action, { syntaxMask: [f.aliases.get('Q0')!] }),
    withPacket(action, { synthesizedText: [f.aliases.get('P2')!] }),
    withPacket(action, { syntaxMask: [{ ...f.aliases.get('P3')!, length: 1 }] }),
  ]) {
    const rejected = store(f);
    rejected.append(invalid);
    const snapshot = rejected.snapshot();
    expect(snapshot.ready).toEqual([]);
    expect(snapshot.actions[0]!.readiness.state).toBe('quarantined');
  }
});

test('concurrent transfers cannot invalidate earlier source masks during exact-author certification', () => {
  const f = fixture();
  const heading = author(f, 'A1', (f) => [interpret(f)]);
  const transfer = author(f, 'B1', (f) => [f.transfer(['P0', 'P1'], 'Q:end', 'moved')]);
  const a = store(f);
  a.append(transfer);
  a.append(heading);
  const b = store(f);
  b.append(heading);
  b.append(transfer);
  expect(a.snapshot().ready).toEqual(b.snapshot().ready);
  expect(a.snapshot().ready).toHaveLength(2);
});

test('certifies conversion placement destinations through ownership and rejects malformed losing placements', () => {
  const f = fixture();
  const valid = author(f, 'A1', (f) => {
    f.createBlock({ id: 'W', parent: 'root', role: 'quote' }, null);
    const move = f.move('P', 'W');
    if (move.type !== 'MoveBlock') throw new Error();
    const heading = interpret(f);
    if (heading.type !== 'Interpret') throw new Error();
    return [
      {
        type: 'Interpret',
        packet: {
          ...heading.packet,
          wrappers: [f.id('W', 'node')],
          placements: [{ node: move.node, occurrence: move.occurrence, slot: move.slot }],
        },
      },
      {
        type: 'Interpret',
        packet: {
          ...heading.packet,
          id: f.allocate('code', 'interpretation'),
          properties: { presentation: 'code', marker: null, info: null },
          syntaxMask: [],
        },
      },
    ];
  });
  const accepted = store(f);
  accepted.append(valid);
  expect(accepted.snapshot().ready).toHaveLength(1);
  const original = packet(valid);
  const placement = original.placements[0]!;
  const invalid = withPacket(valid, {
    placements: [{ ...placement, slot: { ...placement.slot, parent: f.id('root', 'node') } }],
  });
  const rejected = store(f);
  rejected.append(invalid);
  expect(rejected.snapshot().actions[0]!.readiness).toEqual({
    state: 'quarantined',
    reason: 'reference',
  });
  expect(
    resourceKey(
      accepted.snapshot().ready[0]!.allocations.find((entry) => entry.type === 'node')!.id,
    ),
  ).toBe(resourceKey(f.id('W', 'node')));
});

test('indexed refinement propagates operational native-read failures and rejects malformed cell data', () => {
  const f = fixture();
  const birth = f.bodies.get('G')!.nativeManifest.find((birth) => birth.type === 'text')!;
  const candidate = { ...emptyAction(), nativeManifest: [birth] };
  const validate = createProjectionAuthorValidator({ genesis: f.genesis, births: () => [] });
  const context: AuthorValidationContext = {
    get dependencies(): readonly ActionEnvelope[] {
      throw new Error('Indexed refinement enumerated its closure');
    },
    indexed: {
      dependencies: [],
      resultIdentity: {},
      past: {
        identity: {},
        contains: () => false,
        groupSealed: () => false,
        allocation: (id) =>
          f.genesis.allocations.find((a) => resourceKey(a.id) === resourceKey(id)),
      },
    },
    native: nativeView(f.peers.get('A')!),
  };
  const failure = new Error('native host read failed');
  expect(() =>
    validate(candidate, {
      indexed: context.indexed,
      get dependencies() {
        return context.dependencies;
      },
      native: {
        ...context.native,
        snapshot: () => {
          throw failure;
        },
      },
    }),
  ).toThrow(failure);
  expect(
    validate(candidate, {
      indexed: context.indexed,
      get dependencies() {
        return context.dependencies;
      },
      native: { ...context.native, snapshot: (tape) => ({ tape, length: 0, parts: [] }) },
    }),
  ).toBe('reference');
});
