import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import {
  rawObservation,
  markers,
  firstTape,
} from '../../../../benchmarks/multiwriter/structural-refinement.js';
import { insertParagraph, insertText, joinWithPrevious } from '../authoring/index.js';
import { reconstructProvenance } from '../reference/provenance.js';
import { reduceActivity } from '../visibility/activity.js';
import { encodeEnvelope } from '../actions/codec.js';
import { actionKey } from '../actions/references.js';
import { captureDiagnostics } from '../diagnostics.js';
import { finish } from '../ingest/work.js';
import { MaterializedOwnership } from './coupled.js';
import { resourceKey } from '../layout/index.js';

function applied(result: ReturnType<CommandReplica['editor']['edit']>) {
  if (result.status !== 'applied') throw new Error('Expected applied edit');
  return result;
}
/** Prepare provenance/reference activity outside the B work interval. C and D
 * own those callers. The production B API must not enumerate the retained input
 * again, even if its caller has already materialized a complete projection input.
 */
function prepare(
  p: CommandReplica,
  owner: MaterializedOwnership,
  forbidBefore = 0,
  options: {
    readonly reverse?: boolean;
    readonly unindexed?: boolean;
    readonly changedBody?: boolean;
  } = {},
) {
  if (!('readyActions' in p.document)) throw new Error('Expected indexed ready source');
  const sequence = p.document.readyActions(),
    actions = [...sequence],
    publication = p.document.publication.status().publication!,
    provenance = reconstructProvenance(p.genesis.layout, actions),
    activity = reduceActivity(actions),
    variants = new Map(actions.map((action) => [actionKey(action.id), encodeEnvelope(action)]));
  const entries = options.changedBody
    ? provenance.actions.map((entry) => ({
        ...entry,
        action: {
          ...entry.action,
          groupId: { ...entry.action.groupId, sequence: entry.action.groupId.sequence + 100n },
        },
      }))
    : provenance.actions;
  const guarded = new Proxy(options.reverse ? [...entries].reverse() : entries, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) < forbidBefore)
        throw new Error(`Enumerated retained action ${key}`);
      return Reflect.get(target, key, receiver);
    },
  });
  return captureDiagnostics(() =>
    finish(
      owner.prepare(
        {
          genesis: p.genesis.layout,
          genesisManifest: p.genesis.body.nativeManifest,
          initialProperties: p.genesis.initialProperties,
          ...provenance,
          actions: guarded,
          native: publication.native,
        },
        activity,
        variants,
        undefined,
        options.unindexed ? undefined : sequence,
      ),
    ),
  );
}

for (const history of ['text', 'layout'] as const)
  for (const depth of [0, 8, 32])
    test(`coupled split/type/join inspects only its suffix after ${depth} unrelated ${history} actions`, () => {
      const p = commandReplica(
          commandGenesis('abcdef\n\nxyz\n\nu\n\nv'),
          undefined,
          'materialized',
        ),
        oracle = createMaterializationOracle(),
        owner = new MaterializedOwnership();
      try {
        const target = p.handle(p.nodes()[0]),
          other = p.handle(p.nodes()[1]),
          u = p.handle(p.nodes()[2]),
          v = p.handle(p.nodes()[3]);
        for (let i = 0; i < depth; i++) {
          if (history === 'text')
            applied(
              p.editor.session('prefix').edit(insertText, { nodeId: other, from: 1, text: 'x' }),
            );
          else
            applied(
              p.editor.session('prefix').edit(
                (ctx, input: { node: typeof v; after: typeof u }) => {
                  ctx.draft.place(input.node, ctx.scopeRoot, input.after);
                  return { status: 'handled' };
                },
                { node: v, after: i % 2 ? u : other },
              ),
            );
        }
        prepare(p, owner).value.commit();
        let count = depth;
        const step = (command: () => void, expectedCandidates: number) => {
          command();
          const prepared = prepare(p, owner, count);
          expect(prepared.value.value.changes).toMatchObject({
            replayFrom: count,
            replayTo: count + 1,
          });
          const work = prepared.report.work;
          expect(work['driver/coupled.actionsCompared']).toBe(1);
          expect(work['driver/ownership.suffixActions']).toBe(1);
          expect(work['driver/ownership.sortInputs'] ?? 0).toBe(0);
          expect(work['driver/ownership.fullInputEnumerated'] ?? 0).toBe(0);
          expect(work['driver/ownership.retainedStructuralCandidates'] ?? 0).toBeLessThanOrEqual(
            expectedCandidates,
          );
          const independent = commandReplica(
            p.genesis,
            p.document.store.encodeUpdate(),
            'reference',
          );
          try {
            expect(rawObservation(prepared.value.value.ownership)).toEqual(
              rawObservation(
                independent.document.publication.status().publication!.value.ownership,
              ),
            );
          } finally {
            independent.close();
          }
          prepared.value.commit();
          expect(owner.diagnostics().lastReplayLength).toBe(1);
          count++;
          oracle.check(p.document, p.genesis);
        };
        step(() => {
          applied(p.editor.session('split').edit(insertParagraph, { nodeId: target, from: 2 }));
        }, 1);
        const right = p.handle(p.nodes()[1]);
        step(() => {
          applied(
            p.editor.session('left').edit(insertText, { nodeId: target, from: 1, text: 'L' }),
          );
        }, 0);
        step(() => {
          applied(
            p.editor.session('right').edit(insertText, { nodeId: right, from: 1, text: 'R' }),
          );
        }, 0);
        step(() => {
          applied(p.editor.session('join').edit(joinWithPrevious, { nodeId: right }));
        }, 1);
        step(() => {
          applied(
            p.editor.session('elsewhere').edit(insertText, { nodeId: other, from: 1, text: '!' }),
          );
        }, 0);
      } finally {
        owner.evict();
        oracle.destroy();
        p.close();
      }
    });

test('a private candidate cannot commit after cancellation or a competing preparation', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized'),
    owner = new MaterializedOwnership();
  try {
    const first = prepare(p, owner).value;
    owner.cancel();
    expect(() => first.commit()).toThrow('no longer current');
    const current = prepare(p, owner).value;
    const later = prepare(p, owner).value;
    expect(() => current.commit()).toThrow('no longer current');
    later.commit();
    expect(() => later.commit()).toThrow('no longer current');
  } finally {
    owner.evict();
    p.close();
  }
});

test('a known suffix must match its certified order; unknown permutations use the full ordering audit', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized'),
    owner = new MaterializedOwnership();
  try {
    prepare(p, owner).value.commit();
    for (let i = 0; i < 2; i++)
      applied(
        p.editor.session('ordered').edit(insertText, {
          nodeId: p.handle(p.nodes()[0]),
          from: 1,
          text: String(i),
        }),
      );
    expect(() => prepare(p, owner, 0, { reverse: true })).toThrow('exact ready payload');
    expect(() => prepare(p, owner, 0, { changedBody: true })).toThrow('exact ready payload');
    expect(() => prepare(p, owner, 0, { changedBody: true, unindexed: true })).toThrow(
      'exact ready payload',
    );
    const audited = prepare(p, owner, 0, { reverse: true, unindexed: true });
    expect(audited.report.work['driver/ownership.sortInputs']).toBe(2);
    expect(rawObservation(audited.value.value.ownership)).toEqual(
      rawObservation(p.document.publication.status().publication!.value.ownership),
    );
    audited.value.commit();
  } finally {
    owner.evict();
    p.close();
  }
});

test('a cancelled suspended preparation cannot expose a completed candidate', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized'),
    owner = new MaterializedOwnership();
  try {
    const work = owner.prepare(
      {
        genesis: p.genesis.layout,
        genesisManifest: p.genesis.body.nativeManifest,
        actions: [],
        birthContent: [],
        native: p.document.publication.status().publication!.native,
      },
      reduceActivity([]),
      new Map(),
    );
    expect(work.next().done).toBe(false);
    owner.cancel();
    expect(() => finish(work)).toThrow('no longer current');
  } finally {
    owner.evict();
    p.close();
  }
});

test('a changed component visits its retained placement readers while unrelated readers stay indexed', () => {
  const p = commandReplica(commandGenesis('abc\n\nu\n\nv'), undefined, 'materialized'),
    owner = new MaterializedOwnership(),
    oracle = createMaterializationOracle();
  try {
    const first = p.handle(p.nodes()[0]),
      u = p.handle(p.nodes()[1]),
      v = p.handle(p.nodes()[2]);
    const move = (after: typeof u) =>
      applied(
        p.editor.session('moves').edit(
          (ctx, input: { after: typeof u }) => {
            ctx.draft.place(v, ctx.scopeRoot, input.after);
            return { status: 'handled' };
          },
          { after },
        ),
      );
    for (let i = 0; i < 16; i++) move(i % 2 ? u : first);
    prepare(p, owner).value.commit();
    move(first);
    const changed = prepare(p, owner, 16);
    expect(changed.report.work['driver/coupled.actionsCompared']).toBe(1);
    const nodes = new Set(changed.value.value.changes.layout.blocks.map((entry) => entry.key)),
      flows = new Set(changed.value.value.changes.layout.flows.map((entry) => entry.key));
    const relevant = p.document.store
      .snapshot()
      .ready.flatMap((action) => action.effects)
      .filter(
        (effect) =>
          effect.type === 'MoveBlock' &&
          (nodes.has(resourceKey(effect.node)) ||
            (effect.standaloneFlow && flows.has(resourceKey(effect.standaloneFlow)))),
      ).length;
    expect(relevant).toBeGreaterThan(1);
    expect(changed.report.work['driver/ownership.retainedStructuralCandidates']).toBe(relevant);
    expect(changed.value.value.changes.layout.blocks).toHaveLength(1);
    expect(changed.value.value.changes.payloads).toHaveLength(1);
    changed.value.commit();
    oracle.check(p.document, p.genesis);
  } finally {
    owner.evict();
    oracle.destroy();
    p.close();
  }
});

test('payload withdrawal retracts marker addresses and cannot reuse an exact old prefix', () => {
  const p = commandReplica(commandGenesis('abc\n\ntail'), undefined, 'materialized'),
    owner = new MaterializedOwnership(),
    oracle = createMaterializationOracle();
  try {
    const tape = firstTape(p),
      snapshot = p.document.publication.status().publication!.native.snapshot(tape);
    const body = markers(p, tape, snapshot.parts.find((part) => part.type === 'text')!.index);
    const prior = prepare(p, owner).value;
    prior.commit();
    const assignments = prior.value.ownership.assignments;
    p.document.store.append({ ...body, groupId: { ...body.groupId, sequence: 999n } });
    p.editor.refresh();
    const changed = prepare(p, owner);
    expect(changed.value.value.changes).toMatchObject({
      replayFrom: 0,
      reason: 'native-withdrawal-or-reorder',
    });
    expect(changed.value.value.changes.payloads.some((entry) => entry.before && !entry.after)).toBe(
      true,
    );
    expect(
      changed.value.value.changes.assignments.some((entry) => entry.before && !entry.after),
    ).toBe(true);
    expect(prior.value.ownership.assignments).toEqual(assignments);
    changed.value.commit();
    oracle.check(p.document, p.genesis);
  } finally {
    owner.evict();
    oracle.destroy();
    p.close();
  }
});
