import * as Y from 'yjs';
import { expect, test, vi } from 'vitest';
import { encodeEnvelope } from './actions/codec.js';
import type { ActionEnvelope } from './contracts.js';
import { NativeFixture } from './ownership/test-fixtures.js';
import { DirectionalActionProvider } from './providers/adapter.js';
import { openReferenceDocument } from './reference/document.js';
import { serializeProjection } from './projection/index.js';
import * as provenance from './reference/provenance.js';
import { IngestCapacityError } from './ingest/work.js';

const paragraph = (id: string, text: string) => ({
  id,
  parent: 'root',
  role: 'inline' as const,
  flow: `f${id}`,
  run: `r${id}`,
  tape: `t${id}`,
  cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
});
function carrier(action: ActionEnvelope): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    doc.getArray<Uint8Array>('envelopes').push([encodeEnvelope(action)]);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

for (const kind of ['ordinary-chained', 'ordinary-ambiguous', 'duplicate-split'] as const)
  test.each([false, true])(
    `remote ${kind} preserves unrelated ready progress; reverse=%s`,
    async (reverse) => {
      const f = new NativeFixture([
        { id: 'root', parent: null, role: 'root' },
        paragraph('P', 'xy'),
      ]);
      const genesis = {
        documentId: 'D',
        genesisId: 'G',
        layout: f.genesis,
        body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
      };
      const document = openReferenceDocument(genesis);
      const journal: Uint8Array[] = [];
      const provider = await DirectionalActionProvider.open({
        store: document.store,
        mode: 'bidirectional',
        journal: {
          read: async () => [],
          append: async (bytes) => {
            journal.push(bytes.slice());
          },
          close() {},
        },
      });
      try {
        f.author('A1', (f) => {
          if (kind === 'duplicate-split')
            return [f.split('P', 'S', 'P0', 'left', 'root', 'P:birth')];
          f.createBlock({ id: 'U', parent: 'root', role: 'quote' }, null);
          f.createBlock(
            { id: 'V', parent: 'root', role: 'quote' },
            kind === 'ordinary-chained' ? 'U:birth' : null,
          );
          return [];
        });
        f.author('B1', (f) => f.insert('BZ', 'z', 'P:after-x'));
        const original = f.envelope('A1');
        const candidate =
          kind === 'duplicate-split'
            ? { ...original, effects: [...original.effects, original.effects[0]] }
            : original;
        const updates = [carrier(candidate), carrier(f.envelope('B1'))];
        expect(document.publication.refresh().state).toBe('complete');
        for (const update of reverse ? updates.toReversed() : updates) {
          provider.receive('peer', update);
          if (reverse && update === updates[1])
            expect(document.publication.refresh().state).toBe('complete');
        }
        await provider.flush();
        const bytes = document.store.encodeUpdate();
        function inspect(d: ReturnType<typeof openReferenceDocument>) {
          const state = d.store.snapshot();
          expect(state.actions).toHaveLength(2);
          expect(state.ready.some((a) => a.id.actor === f.envelope('B1').id.actor)).toBe(true);
          expect(state.actions.find((a) => a.id.actor === original.id.actor)?.readiness).toEqual(
            kind === 'ordinary-chained'
              ? { state: 'ready' }
              : { state: 'quarantined', reason: 'reference' },
          );
          const publication = d.publication.refresh();
          expect(publication.state).toBe('complete');
          if (publication.state === 'complete')
            expect(serializeProjection(publication.value.value.view)).toContain('xzy');
        }
        inspect(document);
        inspect(document);
        expect(document.store.encodeUpdate()).toEqual(bytes);
        const fresh = openReferenceDocument(genesis);
        try {
          fresh.store.applyUpdate(bytes);
          inspect(fresh);
          expect(fresh.store.encodeUpdate()).toEqual(bytes);
        } finally {
          fresh.destroy();
        }
      } finally {
        await provider.close();
        document.destroy();
        f.destroy();
      }
    },
  );

for (const failure of [
  new Error('Host failure'),
  new IngestCapacityError('validation', 'operations', 10001),
  'non-Error host failure',
])
  test(`reference admission propagates ${String(failure)}`, () => {
    const f = new NativeFixture([{ id: 'root', parent: null, role: 'root' }, paragraph('P', 'xy')]);
    f.author('A1', (f) => {
      f.createBlock({ id: 'U', parent: 'root', role: 'quote' }, null);
      return [];
    });
    const spy = vi.spyOn(provenance, 'reconstructBirths').mockImplementation(() => {
      throw failure;
    });
    const document = openReferenceDocument({
      documentId: 'D',
      genesisId: 'G',
      layout: f.genesis,
      body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    });
    try {
      document.store.applyUpdate(carrier(f.envelope('A1')));
      const before = document.store.encodeUpdate();
      for (let retry = 0; retry < 2; retry++) {
        let caught: unknown;
        try {
          document.store.snapshot();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(document.store.encodeUpdate()).toEqual(before);
      }
    } finally {
      spy.mockRestore();
      document.destroy();
      f.destroy();
    }
  });
