import { expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { publication, insert } from '../../../../test/multiwriter/bootstrap-helpers.js';
import { serializeProjection } from '../projection/index.js';
import { encodeEnvelope } from '../actions/codec.js';
import { IngestCapacityError } from '../ingest/work.js';
import { scanUpdate } from '../ingest/preflight.js';
import { envelopeToWire } from '../actions/schema.js';
import { decodeCbor, encodeCbor } from '../actions/cbor.js';
import type { CborValue } from '../actions/cbor.js';
import {
  BootstrapCompatibilityError,
  createGenesis,
  decodeBundle,
  decodeGenesis,
  encodeBundle,
  encodeGenesis,
  openBootstrap,
} from './index.js';
import { referenceGenesis } from './descriptor.js';
import type { BootstrapOpenOptions } from './index.js';

const bytes = createGenesis('bundle-test', 'original😀');
const genesis = referenceGenesis(decodeGenesis(bytes));
function options(extra: Partial<BootstrapOpenOptions> = {}): BootstrapOpenOptions {
  return {
    genesis: bytes,
    persistedGenesis: bytes,
    mode: 'bidirectional',
    journal: { read: async () => [], append: async () => {}, close() {} },
    ...extra,
  };
}
test('missing or conflicting durable metadata fails before opening the journal', async () => {
  let reads = 0;
  const journal = {
    read: async () => {
      reads++;
      return [];
    },
    append: async () => {},
    close() {},
  };
  await expect(openBootstrap(options({ persistedGenesis: undefined, journal }))).rejects.toThrow(
    'metadata is missing',
  );
  await expect(
    openBootstrap(
      options({ persistedGenesis: createGenesis('bundle-test', 'original😀'), journal }),
    ),
  ).rejects.toThrow('differs');
  expect(reads).toBe(0);
});
test('failed journal restoration closes the journal and exposes no replica', async () => {
  let closed = 0;
  await expect(
    openBootstrap(
      options({
        journal: {
          read: async () => {
            throw new Error('storage unavailable');
          },
          append: async () => {},
          close() {
            closed++;
          },
        },
      }),
    ),
  ).rejects.toThrow('storage unavailable');
  expect(closed).toBe(1);
});
test('own journal restores in disconnected mode and never regenerates genesis', async () => {
  const a = await openBootstrap(options());
  const entries: Uint8Array[] = [];
  const ownJournal = () => ({
    read: async () => entries.map((u) => u.slice()),
    append: async (u: Uint8Array) => {
      entries.push(u.slice());
    },
    close() {},
  });
  try {
    a.document.store.append(insert(genesis, '!', 1));
    const prior = await openBootstrap(options({ journal: ownJournal() }));
    try {
      expect(prior.receiveBundle('peer', a.captureBundle()).state).toBe('admitted');
      await prior.provider.flush();
    } finally {
      await prior.close();
    }
    const b = await openBootstrap(options({ mode: 'disconnected', journal: ownJournal() }));
    try {
      expect(serializeProjection(publication(b.document).value.view)).toBe('original😀!\n');
      expect(b.genesisBytes()).toEqual(bytes);
      expect(b.document.store.encodeUpdate()).toEqual(a.document.store.encodeUpdate());
      expect(publication(b.document).native.encodeState()).toEqual(
        publication(a.document).native.encodeState(),
      );
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
});
test('strict one-way full bundles recover loss and merge duplicate/reversed offline branches', async () => {
  const a = await openBootstrap(options({ mode: 'outbound-only' }));
  const b = await openBootstrap(options({ mode: 'inbound-only' }));
  const c = await openBootstrap(options());
  try {
    a.document.store.append(insert(genesis, 'a', 1));
    c.document.store.append(insert(genesis, 'c', 2));
    const first = a.captureBundle(); // first send is dropped; no reverse traffic or handshake
    const second = c.captureBundle();
    expect(a.receiveBundle('catch-up', second).state).toBe('disabled');
    expect(b.receiveBundle('peer', second).state).toBe('admitted');
    expect(b.receiveBundle('peer', first).state).toBe('admitted');
    b.receiveBundle('peer', a.captureBundle());
    c.receiveBundle('catch-up', first);
    c.receiveBundle('self-echo', c.captureBundle());
    const session = a.session;
    const before = a.document;
    const store = a.document.store;
    const publicationBoundary = a.document.publication;
    a.provider.setMode('bidirectional');
    a.receiveBundle('catch-up', b.captureBundle());
    expect(a.document).toBe(before);
    expect(a.session).toBe(session);
    expect(a.document.store).toBe(store);
    expect(a.document.publication).toBe(publicationBoundary);
    for (const peer of [a, b, c]) {
      expect(peer.document.store.snapshot().ready).toHaveLength(2);
      expect(peer.document.store.encodeUpdate()).toEqual(a.document.store.encodeUpdate());
      expect(publication(peer.document).native.encodeState()).toEqual(
        publication(a.document).native.encodeState(),
      );
      expect(publication(peer.document).value.view).toEqual(publication(a.document).value.view);
    }
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});
for (const conflict of [
  'document',
  'genesis',
  'same-IDs-properties',
  'schema-2',
  'bootstrap-version',
  'extra-field',
] as const)
  test(`reject ${conflict} bundle before changing an open replica`, async () => {
    const opened = await openBootstrap(options());
    try {
      const before = opened.captureBundle();
      const d = decodeGenesis(bytes);
      if (conflict === 'document') Object.assign(d, { documentId: 'other' });
      if (conflict === 'same-IDs-properties')
        Object.assign(d.initialProperties[0].values, { presentation: 'code' });
      const other =
        conflict === 'genesis' ? createGenesis('bundle-test', 'original😀') : encodeGenesis(d);
      let bad = encodeBundle({
        genesis: other,
        actionUpdate: encodeEnvelope(insert(genesis, '!', 1)),
      });
      const wire = decodeCbor(bad) as Record<string, CborValue>;
      if (conflict === 'schema-2') bad = encodeCbor({ ...wire, protocolVersion: 2n });
      if (conflict === 'bootstrap-version') bad = encodeCbor({ ...wire, bootstrapVersion: 2n });
      if (conflict === 'extra-field') bad = encodeCbor({ ...wire, extra: null });
      expect(() => opened.receiveBundle('peer', bad)).toThrow(BootstrapCompatibilityError);
      expect(opened.captureBundle()).toEqual(before);
    } finally {
      await opened.close();
    }
  });
test('admitted incompatible live envelopes and invalid schema-3 facts remain quarantined', async () => {
  const opened = await openBootstrap(options());
  const carrier = new Y.Doc({ gc: false });
  try {
    const original = insert(genesis, '!', 1);
    const wire = envelopeToWire(original) as Record<string, CborValue>;
    const invalid = { ...insert(genesis, '?', 2), documentId: 'wrong' };
    carrier
      .getArray('envelopes')
      .push([encodeCbor({ ...wire, protocolVersion: 2n }), encodeEnvelope(invalid)]);
    expect(
      opened.receiveBundle(
        'peer',
        encodeBundle({ genesis: bytes, actionUpdate: Y.encodeStateAsUpdate(carrier) }),
      ).state,
    ).toBe('admitted');
    const snapshot = opened.document.store.snapshot();
    expect(snapshot.ready).toEqual([]);
    expect(snapshot.actions).toHaveLength(2);
    expect(snapshot.actions.every((a) => a.readiness.state === 'quarantined')).toBe(true);
    expect(serializeProjection(publication(opened.document).value.view)).toBe('original😀\n');
  } finally {
    carrier.destroy();
    await opened.close();
  }
});
test('pending outer prefix and fork variants survive capture, reopen and cache eviction', async () => {
  const carrier = new Y.Doc({ gc: false });
  const updates: Uint8Array[] = [];
  carrier.on('update', (u: Uint8Array) => updates.push(u.slice()));
  const a = await openBootstrap(options());
  try {
    const original = insert(genesis, 'x', 1);
    carrier.getArray('envelopes').push([encodeEnvelope(original)]);
    const wire = envelopeToWire(original) as Record<string, CborValue>;
    carrier.getArray('envelopes').push([encodeCbor({ ...wire, protocolVersion: 2n })]);
    a.receiveBundle('peer', encodeBundle({ genesis: bytes, actionUpdate: updates[1] }));
    expect(a.document.store.snapshot().actions).toEqual([]);
    const held = decodeBundle(a.captureBundle()).actionUpdate;
    const b = await openBootstrap(options());
    try {
      b.receiveBundle('peer', a.captureBundle());
      expect(b.document.store.encodeUpdate()).toEqual(held);
      for (const peer of [a, b])
        peer.receiveBundle('peer', encodeBundle({ genesis: bytes, actionUpdate: updates[0] }));
      expect(a.document.store.snapshot().actions[0].variants).toHaveLength(2);
      expect(a.document.store.snapshot().ready).toEqual([]);
      expect(b.document.store.encodeUpdate()).toEqual(a.document.store.encodeUpdate());
      expect(publication(b.document).native.encodeState()).toEqual(
        publication(a.document).native.encodeState(),
      );
      const journal = decodeBundle(a.captureBundle()).actionUpdate;
      const reopened = await openBootstrap(
        options({ journal: { read: async () => [journal], append: async () => {}, close() {} } }),
      );
      try {
        expect(reopened.captureBundle()).toEqual(a.captureBundle());
        expect(reopened.session.actor).not.toBe(a.session.actor);
        expect(reopened.session.local).not.toBe(a.session.local);
        expect(publication(reopened.document).value.view).toEqual(
          publication(a.document).value.view,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await b.close();
    }
  } finally {
    carrier.destroy();
    await a.close();
  }
});
test('detached bundle bytes and repeated reads/projection never author canonical facts', async () => {
  const input = bytes.slice();
  const opened = await openBootstrap(options({ genesis: input }));
  input.fill(0);
  try {
    const before = opened.captureBundle();
    const decoded = decodeBundle(before);
    decoded.genesis.fill(0);
    decoded.actionUpdate.fill(0);
    opened.genesisBytes().fill(0);
    for (let i = 0; i < 3; i++) serializeProjection(publication(opened.document).value.view);
    expect(opened.genesisBytes()).toEqual(bytes);
    expect(opened.captureBundle()).toEqual(before);
  } finally {
    await opened.close();
  }
});
test('failed durability close retains the replica for retry', async () => {
  let failure = true;
  const opened = await openBootstrap(
    options({
      journal: {
        read: async () => [],
        append: async () => {
          if (failure) throw new Error('disk full');
        },
        close() {},
      },
    }),
  );
  opened.document.store.append(insert(genesis, '!', 1));
  await expect(opened.close()).rejects.toThrow('disk full');
  expect(opened.document.store.snapshot().ready).toHaveLength(1);
  failure = false;
  await opened.provider.retryPersistence();
  await opened.close();
});

test('raw schema-2 storage update is rejected before live carrier mutation', async () => {
  const opened = await openBootstrap(options());
  const schema2 = new Y.Doc();
  try {
    schema2.getMap('nodes').set('root', { type: 'document' });
    const before = opened.captureBundle();
    expect(() =>
      opened.receiveBundle(
        'peer',
        encodeBundle({ genesis: bytes, actionUpdate: Y.encodeStateAsUpdate(schema2) }),
      ),
    ).toThrow();
    expect(opened.captureBundle()).toEqual(before);
  } finally {
    schema2.destroy();
    await opened.close();
  }
});

test('bundle/provider capacity retries preserve the live session', async () => {
  const source = await openBootstrap(options());
  const receiver = await openBootstrap(
    options({
      bootstrapLimits: { bytes: bytes.length },
      limits: { messageBytes: 0 },
    }),
  );
  const larger = { bytes: 1024 * 1024 };
  const session = receiver.session;
  try {
    source.document.store.append(insert(genesis, '!', 1));
    const bundle = source.captureBundle();
    const before = receiver.captureBundle(larger);
    expect(() => receiver.captureBundle()).toThrow(IngestCapacityError);
    expect(() => receiver.receiveBundle('peer', bundle)).toThrow(IngestCapacityError);
    expect(receiver.receiveBundle('peer', bundle, larger).state).toBe('backpressured');
    expect(receiver.captureBundle(larger)).toEqual(before);
    receiver.provider.setLimits({ messageBytes: 1024 * 1024 });
    expect(receiver.receiveBundle('peer', bundle, larger).state).toBe('admitted');
    expect(receiver.captureBundle(larger)).toEqual(bundle);
    expect(receiver.session).toBe(session);
  } finally {
    await source.close();
    await receiver.close();
  }
});

test.each(['certification', 'publication'] as const)(
  'native %s capacity retry publishes retained facts in the same live replica',
  async (stage) => {
    const seed = createGenesis('native-retry', '');
    const descriptor = decodeGenesis(seed);
    const g = referenceGenesis(descriptor);
    const smallLimit = Math.max(
      ...descriptor.nativeInsertUpdates.map((u) => [...scanUpdate(u, 'native')].length + 1),
    );
    const source = await openBootstrap(options({ genesis: seed, persistedGenesis: seed }));
    const target = await openBootstrap(
      options({
        genesis: seed,
        persistedGenesis: seed,
        bootstrapLimits: { nativeOperations: stage === 'certification' ? smallLimit : 100_000 },
      }),
    );
    const { document, provider, session } = target;
    const previous = document.publication.status().publication!;
    try {
      // Isolate publication failure from successful native certification using its public API.
      if (stage === 'publication') document.publication.setDecodeLimit(smallLimit);
      source.document.store.append(insert(g, 'x'.repeat(10_000), 1));
      expect(target.receiveBundle('peer', source.captureBundle()).state).toBe('admitted');
      const held = target.captureBundle();
      if (stage === 'certification')
        expect(() => document.store.snapshot()).toThrow(IngestCapacityError);
      else expect(document.store.snapshot().ready).toHaveLength(1);
      expect(() => publication(document)).toThrow(IngestCapacityError);

      document.setNativeDecodeLimit(100_000);
      expect(document.publication.status()).toMatchObject({ stale: true, canAuthor: false });
      expect(document.publication.status().publication!.value).toBe(previous.value);
      // No retransmission or reopening: retry the original retained facts.
      const recovered = publication(document);
      expect(serializeProjection(recovered.value.view)).toBe('x'.repeat(10_000) + '\n');
      expect(recovered.native.encodeState()).toEqual(
        publication(source.document).native.encodeState(),
      );
      expect(document.store.snapshot()).toMatchObject({
        diagnostics: [],
        ready: [expect.anything()],
      });
      expect(document.publication.status()).toMatchObject({ stale: false, canAuthor: true });
      expect(target.captureBundle()).toEqual(held);
      expect(target.document).toBe(document);
      expect(target.provider).toBe(provider);
      expect(target.session).toBe(session);
      await provider.flush();
    } finally {
      await source.close();
      await target.close();
    }
  },
);

test.each(['store', 'publication'] as const)(
  'changing live native capacity cancels suspended %s work and permits fresh publication',
  async (owner) => {
    const source = await openBootstrap(options());
    const target = await openBootstrap(options());
    try {
      source.document.store.append(insert(genesis, 'x'.repeat(10_000), 1));
      target.receiveBundle('peer', source.captureBundle());
      const held = target.captureBundle();
      let work =
        owner === 'store'
          ? target.document.store.compute(0)
          : target.document.publication.refresh(0);
      // Advance partially, then change capacity while the computation is suspended.
      for (let step = 0; step < 100 && work.state === 'deferred'; step++)
        work = work.continuation.resume(1);
      expect(work.state).toBe('deferred');
      if (work.state !== 'deferred') throw new Error('Expected suspended computation');
      expect(() => target.document.setNativeDecodeLimit(-1)).toThrow('Invalid local ingest limit');
      target.document.setNativeDecodeLimit(200_000);
      expect(() => work.continuation.resume()).toThrow('invalidated');
      expect(serializeProjection(publication(target.document).value.view)).toBe(
        'original😀' + 'x'.repeat(10_000) + '\n',
      );
      expect(target.captureBundle()).toEqual(held);
    } finally {
      await source.close();
      await target.close();
    }
  },
);

test.each(['', 'abc'])(
  'genesis subtree deletion wins concurrent typing and cold open never revives the initial paragraph: %j',
  async (source) => {
    const seed = createGenesis('deletion-bootstrap', source);
    const g = referenceGenesis(decodeGenesis(seed));
    const a = await openBootstrap(options({ genesis: seed, persistedGenesis: seed }));
    const b = await openBootstrap(options({ genesis: seed, persistedGenesis: seed }));
    try {
      const typing = insert(g, '!', 1);
      const p = publication(a.document);
      const node = g.layout.allocations.find((a) => a.type === 'node' && a.role === 'inline')!;
      if (node.type !== 'node') throw new Error('missing initial paragraph');
      const home = p.value.ownership.homeBindings[0];
      const id = { actor: a.session.actor, sequence: 1n };
      const tag = {
        kind: 'deletion' as const,
        birth: { type: 'action' as const, action: id },
        ordinal: 0,
      };
      const deletion = {
        protocolVersion: 3 as const,
        documentId: g.documentId,
        genesisId: g.genesisId,
        id,
        dependencies: [],
        lamport: 1n,
        groupId: { session: a.session, sequence: 1n },
        allocations: [{ type: 'deletion' as const, id: tag }],
        nativeInsertUpdates: [],
        nativeManifest: [],
        effects: [
          {
            type: 'DeleteSubtree' as const,
            tag,
            scope: {
              target: node.id,
              observedNodes: [node.id],
              ownedIntervals: [home.cell],
              joinedFlows: [],
              heads: [],
            },
          },
        ],
      };
      a.document.certifyLocal(deletion);
      a.document.store.append(deletion);
      b.document.store.append(typing);
      const ua = a.captureBundle(),
        ub = b.captureBundle();
      a.receiveBundle('peer', ub);
      b.receiveBundle('peer', ua);
      for (const peer of [a, b]) {
        const result = publication(peer.document);
        expect(result.value.view.root.children).toEqual([]);
        expect(result.value.visibility.text.every((entry) => !entry.visible)).toBe(true);
        expect(
          result.native
            .lookup({
              tape: typing.nativeManifest.find((m) => m.type === 'text')!.tape,
              ...typing.nativeManifest.find((m) => m.type === 'text')!.native,
            })
            .map((f) => f.text)
            .join(''),
        ).toBe('!');
      }
      const cold = await openBootstrap(options({ genesis: seed, persistedGenesis: seed }));
      try {
        cold.receiveBundle('catch-up', a.captureBundle());
        expect(publication(cold.document).value.view.root.children).toEqual([]);
        expect(cold.captureBundle()).toEqual(a.captureBundle());
        expect(cold.document.store.snapshot().ready).toHaveLength(2);
      } finally {
        await cold.close();
      }
    } finally {
      await a.close();
      await b.close();
    }
  },
);

test('session allocation failure occurs before any journal attachment', async () => {
  let reads = 0;
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(() => {
    throw new Error('RNG unavailable');
  });
  try {
    await expect(
      openBootstrap(
        options({
          journal: {
            read: async () => {
              reads++;
              return [];
            },
            append: async () => {},
            close() {},
          },
        }),
      ),
    ).rejects.toThrow('RNG unavailable');
    expect(reads).toBe(0);
  } finally {
    random.mockRestore();
  }
});
