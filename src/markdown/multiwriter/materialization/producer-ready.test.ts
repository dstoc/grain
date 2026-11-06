import { expect, test, vi } from 'vitest';
import type { ActionEnvelope } from '../contracts.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { markers, firstTape } from '../../../../benchmarks/multiwriter/structural-refinement.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { readySource, registerReadySource } from '../authoring/ready-source.js';
import type { ReadySequence } from '../authoring/ready-source.js';
import { reduceActivity } from '../visibility/activity.js';
import { captureDiagnostics } from '../diagnostics.js';
import { reconstructProvenance } from '../reference/provenance.js';
import { finish } from '../ingest/work.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import { resolveAddress } from '../projection/addresses.js';
import { MaterializedOwnership } from './coupled.js';
import { seed } from '../../../../test/multiwriter/projection-consumer.js';

function input(p: CommandReplica) {
  if (!('readyActions' in p.document)) throw new Error('Expected materialized document');
  const actions = p.document.readyActions();
  return {
    input: {
      genesis: p.genesis.layout,
      genesisManifest: p.genesis.body.nativeManifest,
      initialProperties: p.genesis.initialProperties,
      actions,
      native: p.document.publication.status().publication!.native,
    },
    activity: reduceActivity([...actions]),
    variants: p.document.store.readReady().variants,
  };
}
function equal(p: CommandReplica) {
  const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference');
  try {
    const current = p.document.publication.status().publication!.value,
      reference = cold.document.publication.status().publication!.value;
    expect(current.view).toEqual(reference.view);
    expect(current.visibility).toEqual(reference.visibility);
    expect(current.ownership.assignments).toEqual(reference.ownership.assignments);
    expect(current.ownership.destinationRequirements).toEqual(
      reference.ownership.destinationRequirements,
    );
    expect(compareBytes(p.document.store.encodeUpdate(), cold.document.store.encodeUpdate())).toBe(
      0,
    );
  } finally {
    cold.close();
  }
}

test('indexed production B input never enumerates a certified retained prefix', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized'),
    owner = new MaterializedOwnership();
  try {
    for (let i = 0; i < 10; i++)
      expect(
        p.editor.edit({ local: 'prefix', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[1]),
          from: 1,
          text: 'x',
        }).status,
      ).toBe('applied');
    const before = input(p),
      initial = finish(owner.prepareReady(before.input, before.activity, before.variants));
    initial.commit();
    expect(
      p.editor.session('split').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 })
        .status,
    ).toBe('applied');
    const next = input(p),
      sequence = next.input.actions,
      length = before.input.actions.length;
    const guarded: ReadySequence = {
      length: sequence.length,
      at(i) {
        if (i < length - 1) throw new Error('Retained prefix read');
        return sequence.at(i);
      },
      [Symbol.iterator](): IterableIterator<ActionEnvelope> {
        throw new Error('Complete ready iteration');
      },
    };
    registerReadySource(guarded, readySource(sequence)!);
    const { value: candidate, report } = captureDiagnostics(() =>
      finish(owner.prepareReady({ ...next.input, actions: guarded }, next.activity, next.variants)),
    );
    expect(report.work['driver/coupled.readyAuditEntries'] ?? 0).toBe(0);
    expect(report.work['driver/provenance.fullReconstructions'] ?? 0).toBe(0);
    expect(report.work['driver/provenance.birthActionsInspected']).toBe(1);
    expect(report.work['driver/coupled.actionsCompared']).toBe(1);
    expect(candidate.value.changes).toMatchObject({ replayFrom: length, replayTo: length + 1 });
    const full = reconstructProvenance(p.genesis.layout, [...sequence]).birthContent,
      prior = new Set(
        reconstructProvenance(p.genesis.layout, [...before.input.actions]).birthContent.map((v) =>
          resourceKey(v.node),
        ),
      );
    expect(candidate.value.birthContent).toEqual(
      full.filter((entry) => !prior.has(resourceKey(entry.node))),
    );
    candidate.commit();
    expect(candidate.value.ownership.assignments).toEqual(
      p.document.publication.status().publication!.value.ownership.assignments,
    );
  } finally {
    owner.evict();
    p.close();
  }
});

test('a named C metadata decline reuses one B candidate and reseeds the next structural publication', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  try {
    const prepare = MaterializedOwnership.prototype.prepareReady;
    const spy = vi
      .spyOn(MaterializedOwnership.prototype, 'prepareReady')
      .mockImplementationOnce(function* (
        this: MaterializedOwnership,
        ...args: Parameters<typeof prepare>
      ) {
        const candidate = yield* prepare.apply(this, args);
        return { ...candidate, value: { ...candidate.value, birthContent: [] } };
      });
    let report;
    try {
      const captured = captureDiagnostics(() =>
        p.editor
          .session('split')
          .edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
      );
      expect(captured.value.status).toBe('applied');
      report = captured.report;
    } finally {
      spy.mockRestore();
    }
    expect(report.work['publication/projection.fullFallback.missing-birth-coverage']).toBe(1);
    expect(report.work['publication/provenance.fullReconstructions']).toBe(1);
    expect(report.work['publication/coupled.candidatesPrepared']).toBe(1);
    expect(report.work['publication/coupled.candidatesCommitted']).toBe(1);
    equal(p);
    const next = captureDiagnostics(() =>
      p.editor.session('join').edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }),
    );
    expect(next.value.status).toBe('applied');
    expect(next.report.work['publication/provenance.fullReconstructions'] ?? 0).toBe(0);
    expect(next.report.work['publication/projection.localStructuralCandidates']).toBe(1);
    equal(p);
  } finally {
    p.close();
  }
});

test('withdrawal retracts addresses through named reconstruction and coherent same-B reseeding', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  try {
    const tape = firstTape(p),
      snapshot = p.document.publication.status().publication!.native.snapshot(tape),
      body = markers(p, tape, snapshot.parts.find((part) => part.type === 'text')!.index);
    const held = p.document.publication.status().publication!,
      address = held.value.view.root.children[0].boundaries.find(
        (b) => b.address.type === 'text' && b.address.slot.boundary.birth.type === 'action',
      )!.address;
    expect(resolveAddress(address, held.value.ownership, held.value.visibility).state).toBe(
      'available',
    );
    p.document.store.append({ ...body, groupId: { ...body.groupId, sequence: 999n } });
    const canonical = p.document.store.encodeUpdate(),
      { report } = captureDiagnostics(() => p.editor.refresh());
    expect(report.work['publication/projection.fullFallback.missing-exact-addition']).toBe(1);
    expect(report.work['publication/coupled.candidatesPrepared']).toBe(1);
    expect(report.work['publication/coupled.candidatesCommitted']).toBe(1);
    const current = p.document.publication.status().publication!.value;
    expect(resolveAddress(address, current.ownership, current.visibility).state).toBe(
      'unavailable',
    );
    expect(resolveAddress(address, held.value.ownership, held.value.visibility).state).toBe(
      'available',
    );
    expect(compareBytes(canonical, p.document.store.encodeUpdate())).toBe(0);
    equal(p);
    const next = captureDiagnostics(() =>
      p.editor.session('split').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
    );
    expect(next.value.status).toBe('applied');
    expect(next.report.work['publication/provenance.fullReconstructions'] ?? 0).toBe(0);
    equal(p);
  } finally {
    p.close();
  }
});

test('marker refinement finishes checkpoint work and ready reads before installation', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized'),
    owner = new MaterializedOwnership();
  try {
    for (let i = 0; i < 128; i++)
      expect(
        p.editor.edit({ local: 'prefix', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[1]),
          from: 1,
          text: 'x',
        }).status,
      ).toBe('applied');
    const before = input(p);
    finish(owner.prepareReady(before.input, before.activity, before.variants)).commit();
    const tape = firstTape(p),
      snapshot = p.document.publication.status().publication!.native.snapshot(tape);
    markers(p, tape, snapshot.parts.find((part) => part.type === 'text')!.index);
    const next = input(p),
      sequence = next.input.actions;
    let preparing = true;
    const guarded: ReadySequence = {
      get length() {
        if (!preparing) throw new Error('Ready length read during install');
        return sequence.length;
      },
      at(i) {
        if (!preparing) throw new Error('Ready entry read during install');
        return sequence.at(i);
      },
      [Symbol.iterator]() {
        if (!preparing) throw new Error('Ready iteration during install');
        return sequence[Symbol.iterator]();
      },
    };
    registerReadySource(guarded, readySource(sequence)!);
    const prepared = captureDiagnostics(() =>
      owner.prepareText(guarded, next.input.native, next.activity, next.variants),
    );
    expect(prepared.value).toBeDefined();
    expect(prepared.report.work['driver/refinement.checkpoints']).toBeGreaterThan(0);
    preparing = false;
    const installed = captureDiagnostics(() => {
      prepared.value!.assertCurrent();
      prepared.value!.commit();
    });
    expect(installed.report.work['driver/refinement.checkpoints'] ?? 0).toBe(0);
    expect(installed.report.work['driver/coupled.candidatesCommitted']).toBe(1);
    expect(owner.diagnostics().retainedCheckpoints).toBe(1);
    equal(p);
  } finally {
    owner.evict();
    p.close();
  }
});

test('a changed genesis seed bypasses text reuse and rebuilds coherent projection indexes', () => {
  const p = commandReplica(commandGenesis('```js\nabcdef\n```\n\ntail'), undefined, 'materialized');
  try {
    const seeded = seed(p),
      before = seeded.consumer.diagnostics();
    expect(
      p.editor.session('text').edit(insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 1,
        text: 'X',
      }).status,
    ).toBe('applied');
    const next = input(p),
      changed = structuredClone(p.genesis),
      code = p.nodes()[0].origin.representative;
    const genesis = {
      ...changed,
      initialProperties: changed.initialProperties!.map((entry) =>
        resourceKey(entry.node) === resourceKey(code)
          ? { ...entry, values: { ...entry.values, info: 'reseeded' } }
          : entry,
      ),
    };
    const candidate = finish(
      seeded.consumer.prepare(
        genesis,
        next.input.actions,
        next.input.native,
        next.activity,
        next.variants,
      ),
    );
    expect(candidate.value.view.root.children[0].info).toBe('reseeded');
    expect(seeded.consumer.diagnostics().fullProjections).toBe(before.fullProjections + 1);
    expect(seeded.consumer.diagnostics().localTextProjections).toBe(before.localTextProjections);
    const cold = commandReplica(genesis, p.document.store.encodeUpdate(), 'reference');
    try {
      const expected = cold.document.publication.status().publication!.value;
      expect(candidate.value.view).toEqual(expected.view);
      expect(candidate.value.visibility).toEqual(expected.visibility);
      candidate.commit();
    } finally {
      cold.close();
    }
  } finally {
    p.close();
  }
});
