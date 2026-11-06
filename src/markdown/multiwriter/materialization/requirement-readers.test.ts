import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { seed, change } from '../../../../test/multiwriter/projection-consumer.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { captureDiagnostics } from '../diagnostics.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import type { NodeId } from '../contracts.js';
import type { EffectRef } from '../visibility/activity.js';

const effectKey = (ref: EffectRef) => `${actionKey(ref.action)}:${ref.ordinal}`;
for (const width of [8, 32, 128])
  describe(`reverse requirement reader accounting (${width} destinations)`, () => {
    let f: NativeFixture, p: CommandReplica, initial: ReturnType<typeof seed>;
    beforeAll(() => {
      const inline = (id: string, parent: string) => ({
        id,
        parent,
        role: 'inline' as const,
        flow: `f${id}`,
        run: `r${id}`,
        tape: `t${id}`,
        cells: [{ id: `${id}0`, text: 'abc' }],
      });
      f = new NativeFixture([
        { id: 'root', parent: null, role: 'root' },
        inline('P', 'root'),
        { id: 'source', parent: 'root', role: 'quote' },
        ...Array.from({ length: width }, (_, i) => inline(`child${i}`, 'source')),
        ...Array.from({ length: width }, (_, i) => ({
          id: `Q${i}`,
          parent: 'root',
          role: 'quote' as const,
        })),
      ]);
      f.author('A1', (f) => [
        {
          type: 'LiftChildren',
          placements: Array.from({ length: width }, (_, i) => {
            const move = f.move(`child${i}`, `Q${i}`);
            if (move.type !== 'MoveBlock') throw new Error('Expected move placement');
            return { node: move.node, occurrence: move.occurrence, slot: move.slot };
          }),
        },
      ]);
      const genesis = {
        documentId: 'D',
        genesisId: 'G',
        layout: f.genesis,
        body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
        initialProperties: [],
      };
      p = commandReplica(genesis, undefined, 'materialized');
      const envelope = f.envelope('A1');
      p.document.certifyLocal(envelope);
      p.document.store.append(envelope);
      p.editor.refresh();
      initial = seed(p);
      expect(initial.value.ownership.destinationRequirements[0].nodes).toHaveLength(width);
    });
    afterAll(() => {
      p?.close();
      f?.destroy();
    });
    test('charges actual dependent-array copies even when the candidate is discarded', () => {
      const before = initial.value,
        heldView = structuredClone(before.view),
        heldVisibility = structuredClone(before.visibility);
      expect(
        p.editor.session('text').edit(insertText, {
          nodeId: p.handle(p.nodes()[0]),
          from: 1,
          text: 'X',
        }).status,
      ).toBe('applied');
      const input = change(p, before);
      // A valid conservative superset forces unchanged wide reverse readers to
      // be reinstalled. Every witness still comes from the exact independent export.
      const destinations = Array.from({ length: width }, (_, i) => f.id(`Q${i}`, 'node')),
        requirements = new Map(input.requirements);
      for (const node of destinations) requirements.set(resourceKey(node), []);
      for (const entry of input.structure.value.destinationRequirements)
        for (const node of entry.nodes)
          if (requirements.has(resourceKey(node)))
            requirements.set(resourceKey(node), [
              ...requirements.get(resourceKey(node))!,
              { action: entry.order.action.id, ordinal: entry.order.ordinal },
            ]);
      const oldRefs = new Map<string, EffectRef[]>(),
        reverse = new Map<string, NodeId[]>();
      for (const entry of before.ownership.destinationRequirements)
        for (const node of entry.nodes) {
          const key = resourceKey(node),
            ref = { action: entry.order.action.id, ordinal: entry.order.ordinal };
          oldRefs.set(key, [...(oldRefs.get(key) ?? []), ref]);
          reverse.set(effectKey(ref), [...(reverse.get(effectKey(ref)) ?? []), node]);
        }
      const allocations = new Map(
        input.structure.value.nodeAllocations.map((n) => [resourceKey(n.id), n.id]),
      );
      let inspected = 0,
        copied = 0,
        added = 0,
        references = 0;
      for (const [id, refs] of requirements) {
        for (const ref of oldRefs.get(id) ?? []) {
          references++;
          const key = effectKey(ref);
          const filtered = (reverse.get(key) ?? []).filter((node) => {
            inspected++;
            return resourceKey(node) !== id;
          });
          copied += filtered.length;
          reverse.set(key, filtered);
        }
        for (const ref of refs) {
          references++;
          const key = effectKey(ref),
            readers = reverse.get(key) ?? [];
          inspected += readers.length;
          copied += readers.length;
          added++;
          reverse.set(key, [...readers, allocations.get(id)!]);
        }
      }
      const bytes = p.document.store.encodeUpdate();
      const { value: candidate, report } = captureDiagnostics(() =>
        initial.consumer.prepareStructural({
          ...input,
          containers: [...input.containers, ...destinations],
          requirements,
        }),
      );
      expect(candidate.state, candidate.state === 'fallback' ? candidate.reason : '').toBe(
        'prepared',
      );
      if (candidate.state !== 'prepared') throw new Error(candidate.reason);
      expect(report.work['driver/projection.requirementReaderEntriesInspected']).toBe(inspected);
      expect(report.work['driver/projection.requirementReaderEntriesCopied']).toBe(copied);
      expect(report.work['driver/projection.requirementReaderEntriesAdded']).toBe(added);
      expect(report.work['driver/projection.requirementReferencesInspected']).toBe(references);
      expect(inspected).toBeGreaterThanOrEqual(width * width);
      const cold = commandReplica(p.genesis, bytes);
      try {
        const expected = cold.document.publication.status().publication!.value;
        expect(candidate.value.view).toEqual(expected.view);
        expect(candidate.value.visibility).toEqual(expected.visibility);
      } finally {
        cold.close();
      }
      initial.consumer.evict();
      expect(() => candidate.commit()).toThrow('no longer current');
      expect(before.view).toEqual(heldView);
      expect(before.visibility).toEqual(heldVisibility);
      expect(compareBytes(bytes, p.document.store.encodeUpdate())).toBe(0);
    });
  });
