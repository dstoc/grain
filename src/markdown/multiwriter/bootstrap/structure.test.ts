import { expect, test } from 'vitest';
import { prepareAction, role } from '../../../../test/multiwriter/reference/author.js';
import type { Aliases } from '../../../../test/multiwriter/reference/author.js';
import type { Intent } from '../../../../test/multiwriter/trace.js';
import { publication, insert } from '../../../../test/multiwriter/bootstrap-helpers.js';
import type { ActionEnvelope } from '../contracts.js';
import { NativeTapeCache } from '../text/cache.js';
import { CellIndex } from '../ownership/index.js';
import { resourceKey } from '../layout/index.js';
import { serializeProjection } from '../projection/index.js';
import { createGenesis, decodeGenesis, openBootstrap } from './index.js';
import { referenceGenesis } from './descriptor.js';

test('split, transfer, join, hidden text and owner controls retain original bootstrap identities', async () => {
  const bytes = createGenesis('structural-bootstrap', 'abcdef\n\ntail');
  const genesis = referenceGenesis(decodeGenesis(bytes));
  const options = {
    genesis: bytes,
    persistedGenesis: bytes,
    mode: 'bidirectional' as const,
    journal: { read: async () => [], append: async () => {}, close() {} },
  };
  const a = await openBootstrap(options);
  const b = await openBootstrap(options);
  const native = new NativeTapeCache();
  native.apply('genesis', genesis.body);
  const aliases: Aliases = { ids: new Map(), text: new Map(), ranges: new Map(), slots: new Map() };
  const root = genesis.layout.allocations.find((n) => n.type === 'node' && n.role === 'root')!;
  aliases.ids.set('root', root.id);
  let index = 0;
  const initial = publication(a.document);
  for (const node of genesis.layout.allocations) {
    if (node.type !== 'node' || !node.flow) continue;
    const name = `P${index}`;
    const home = initial.value.ownership.homeBindings.find((h) =>
      initial.value.ownership.runLayouts.some(
        (r) =>
          resourceKey(r.run) === resourceKey(h.run) &&
          resourceKey(r.flow) === resourceKey(node.flow!),
      ),
    )!;
    const birth = genesis.layout.births.find((b) => resourceKey(b.node) === resourceKey(node.id))!;
    aliases.ids.set(name, node.id);
    aliases.ids.set(`${name}:birth`, birth.occurrence);
    aliases.ids.set(`f${name}`, node.flow);
    aliases.ids.set(`r${name}`, home.run);
    aliases.ids.set(`t${name}`, home.cell.tape);
    const content = new CellIndex([native.snapshot(home.cell.tape)]).cells.find(
      (c) => c.fragments.length,
    )!;
    aliases.ranges.set(`C${index}`, content.range);
    aliases.text.set(`T${index}`, content.fragments[0].range);
    aliases.slots.set(`${name}:end`, {
      run: home.run,
      boundary: home.cell.end,
      side: 'left',
      predecessor: null,
    });
    index++;
  }
  const firstText = aliases.text.get('T0')!;
  aliases.text.set('left', { ...firstText, length: 3 });
  aliases.text.set('first', { ...firstText, length: 1 });
  const actor = a.session.actor;
  const actions = new Map<string, ActionEnvelope>();
  function author(intents: readonly Intent[]) {
    publication(a.document);
    const sequence = BigInt(actions.size + 1);
    const name = `A${sequence}`;
    const id = { actor, sequence };
    const prepared = prepareAction({
      command: {
        id: name,
        peer: 'A',
        sequence,
        lamport: sequence,
        dependencies: sequence > 1n ? [`A${sequence - 1n}`] : [],
        group: name,
        intents,
      },
      id,
      session: a.session.local,
      document: a.document,
      native,
      aliases,
      envelope: (name) => {
        const value = actions.get(name);
        if (!value) throw new Error(`Missing ${name}`);
        return value;
      },
    });
    const envelope = {
      ...prepared.envelope,
      documentId: genesis.documentId,
      genesisId: genesis.genesisId,
    };
    try {
      a.document.certifyLocal(envelope);
      a.document.store.append(envelope);
      prepared.commit();
    } catch (error) {
      prepared.abort();
      throw error;
    }
    actions.set(name, envelope);
    for (const intent of intents)
      if (intent.type === 'split') {
        aliases.ids.set(intent.node, role(id, 0, 0, 'node'));
        aliases.ids.set(intent.flow, role(id, 0, 1, 'flow'));
        aliases.ids.set(intent.run, role(id, 0, 2, 'run'));
        const tape = role(id, 0, 3, 'tape');
        aliases.ids.set(`t${intent.node}`, tape);
        aliases.slots.set(`${intent.node}:end`, {
          run: role(id, 0, 2, 'run'),
          boundary: role(id, 0, 5, 'marker'),
          side: 'left',
          predecessor: null,
        });
      }
    return envelope;
  }
  try {
    const originalRanges = initial.value.view.root.children.flatMap((n) =>
      n.fragments.map((f) => ({ range: f.range, text: f.text })),
    );
    author([
      {
        type: 'split',
        source: 'P0',
        basis: ['C0'],
        after: 'left',
        marker: 'cut',
        retainedSide: 'left',
        node: 'S',
        flow: 'fS',
        run: 'rS',
        parent: 'root',
        predecessor: 'P0:birth',
      },
    ]);
    expect(serializeProjection(publication(a.document).value.view)).toBe('abc\n\ndef\n\ntail\n');
    author([{ type: 'transfer', cells: ['C1'], destinationSlot: 'S:end', run: 'transferred' }]);
    expect(serializeProjection(publication(a.document).value.view)).toContain('deftail');
    author([{ type: 'join', source: 'fS', destinationSlot: 'P0:end' }]);
    expect(serializeProjection(publication(a.document).value.view)).toContain('abcdeftail');
    author([{ type: 'delete-text', tag: 'hide', cells: ['first'] }]);
    expect(serializeProjection(publication(a.document).value.view)).toContain('bcdeftail');
    const heldDocument = a.document;
    const heldStore = a.document.store;
    b.receiveBundle('catch-up', a.captureBundle());
    // Catch-up must leave this owner's session able to control its old group.
    a.receiveBundle('catch-up', b.captureBundle());
    author([{ type: 'control', group: 'A4', actions: ['A4'], active: false, previous: null }]);
    expect(serializeProjection(publication(a.document).value.view)).toContain('abcdeftail');
    author([{ type: 'control', group: 'A4', actions: ['A4'], active: true, previous: 'A5' }]);
    expect(a.document).toBe(heldDocument);
    expect(a.document.store).toBe(heldStore);
    b.receiveBundle('peer', a.captureBundle());
    const bundle = a.captureBundle();
    // Cold startup reconstructs every disposable cache, then admits the exact retained tail.
    const c = await openBootstrap(options);
    try {
      c.receiveBundle('peer', bundle);
      for (const peer of [b, c]) {
        const p = publication(peer.document);
        const pa = publication(a.document);
        expect(peer.captureBundle()).toEqual(bundle);
        expect(p.native.encodeState()).toEqual(pa.native.encodeState());
        expect(p.value.view).toEqual(pa.value.view);
        expect(p.value.ownership.assignments).toEqual(pa.value.ownership.assignments);
        expect(p.value.ownership.runLayouts).toEqual(pa.value.ownership.runLayouts);
        expect(p.value.visibility).toEqual(pa.value.visibility);
        for (const { range, text: originalText } of originalRanges) {
          const text = p.native
            .lookup(range)
            .map((f) => f.text)
            .join('');
          expect(text).toBe(originalText);
        }
        expect(p.value.view.root.children.flatMap((n) => n.fragments).some((f) => !f.visible)).toBe(
          true,
        );
      }
      // A writer retained at genesis can still use the original home after cold open.
      const delayed = insert(genesis, '!', 2);
      const old = await openBootstrap(options);
      try {
        old.document.store.append(delayed);
        c.receiveBundle('peer', old.captureBundle());
        expect(c.document.store.snapshot().ready).toHaveLength(7);
        expect(serializeProjection(publication(c.document).value.view)).toContain('!');
      } finally {
        await old.close();
      }
    } finally {
      await c.close();
    }
  } finally {
    native.destroy();
    await a.close();
    await b.close();
  }
});
