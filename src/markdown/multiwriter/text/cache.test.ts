import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
// @ts-expect-error Node APIs are supplied by Vitest; Grain has no @types/node dependency.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node APIs are supplied by Vitest; Grain has no @types/node dependency.
import { createRequire } from 'node:module';
import { actorId, YJS_VERSION } from '../contracts.js';
import type { NativeResourceBirth, ResourceId, ResourceKind } from '../contracts.js';
import { NativeTapeCache } from './cache.js';
import type { NativeBody, NativeInsertion } from './types.js';
import { resourceKey } from './identity.js';

const actor = actorId('00000000000000000000000000000001');
function id<K extends ResourceKind>(kind: K, ordinal: number, sequence?: bigint): ResourceId<K> {
  return {
    kind,
    ordinal,
    birth:
      sequence === undefined
        ? { type: 'genesis', genesisId: 'G' }
        : { type: 'action', action: { actor, sequence } },
  };
}
const tape = id('tape', 0);
const start = id('marker', 1);
const end = id('marker', 2);
const ref = { tape, start, end };
const caches: NativeTapeCache[] = [];
function cache(): NativeTapeCache {
  const result = new NativeTapeCache();
  caches.push(result);
  return result;
}
function publish(
  target: NativeTapeCache,
  key: string,
  operations: readonly NativeInsertion[],
): NativeBody {
  const prepared = target.prepare(key, operations);
  prepared.commit();
  return prepared.body;
}
function genesis(text = ''): NativeBody {
  return publish(cache(), 'G', [
    { type: 'createTape', tape, start, end },
    { type: 'text', tape, index: 1, text },
  ]);
}
function string(target: NativeTapeCache, targetTape = tape): string {
  return target
    .snapshot(targetTape)
    .parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
}
function birth(body: NativeBody): Extract<NativeResourceBirth, { type: 'text' }> {
  const result = body.nativeManifest.find((entry) => entry.type === 'text');
  if (!result || result.type !== 'text') throw new Error('Missing text birth');
  return result;
}
afterEach(() => {
  for (const target of caches.splice(0)) target.destroy();
});

it('uses the installed pinned Yjs package', () => {
  const require = createRequire(import.meta.url);
  expect(JSON.parse(readFileSync(require.resolve('yjs/package.json'), 'utf8')).version).toBe(
    YJS_VERSION,
  );
});

it('captures only each action update on one stable private document', () => {
  const target = cache();
  const client = target.clientId;
  const g = publish(target, 'G', [{ type: 'createTape', tape, start, end }]);
  const x = publish(target, 'A1', [{ type: 'text', tape, index: 1, text: 'x' }]);
  const y = publish(target, 'A2', [{ type: 'text', tape, index: 2, text: 'y' }]);
  expect(target.clientId).toBe(client);
  expect(g.nativeManifest.map((b) => b.type)).toEqual(['marker', 'marker']);
  expect(x.nativeManifest).toEqual([
    { type: 'text', tape, native: { client, clock: 2, length: 1 }, text: 'x' },
  ]);
  expect(y.nativeManifest).toEqual([
    { type: 'text', tape, native: { client, clock: 3, length: 1 }, text: 'y' },
  ]);
  for (const body of [x, y]) {
    expect(body.nativeInsertUpdates).toHaveLength(1);
    const decoded = Y.decodeUpdate(body.nativeInsertUpdates[0]);
    expect(decoded.structs.map((s) => s.length)).toEqual([1]);
    expect(decoded.ds.clients.size).toBe(0);
  }
  expect(Object.keys(target)).toEqual([]);
  const replay = cache();
  replay.apply('G', g);
  replay.apply('A1', x);
  replay.apply('A2', y);
  expect(replay.snapshot(tape)).toEqual(target.snapshot(tape));
});

it('converges real independent concurrent clients and preserves exact observed ranges', () => {
  const g = genesis('ab');
  const peers = [cache(), cache(), cache()];
  for (const peer of peers) peer.apply('G', g);
  expect(new Set(peers.map((p) => p.clientId)).size).toBe(3);
  const updates = peers.map((peer, n) =>
    publish(peer, `P${n}`, [{ type: 'text', tape, index: 2, text: ['X', 'Y', 'Z'][n] }]),
  );
  for (const [n, peer] of peers.entries()) {
    for (const i of [2, 0, 1]) peer.apply(`P${i}`, updates[i]);
    peer.apply(`P${n}`, updates[n]);
  }
  expect(peers[0].snapshot(tape)).toEqual(peers[1].snapshot(tape));
  expect(peers[1].snapshot(tape)).toEqual(peers[2].snapshot(tape));
  const observed = birth(g);
  expect(
    peers[0]
      .lookup({ tape, ...observed.native })
      .map((part) => part.text)
      .join(''),
  ).toBe('ab');
  expect(
    peers[0]
      .range(ref)
      .map((part) => part.text)
      .join(''),
  ).toMatch(/^a[XYZ]{3}b$/);
  const fresh = cache();
  fresh.rebuild([{ key: 'G', body: g }, ...updates.map((body, n) => ({ key: `P${n}`, body }))]);
  expect(fresh.snapshot(tape)).toEqual(peers[0].snapshot(tape));
});

it('retains permanent same-gap markers, zero-character cells, and affinities through replay', () => {
  const g = genesis('ab');
  const a = cache();
  const b = cache();
  a.apply('G', g);
  b.apply('G', g);
  const m1 = id('marker', 3, 1n);
  const m2 = id('marker', 4, 1n);
  const action = publish(a, 'A1', [
    { type: 'marker', tape, index: 2, marker: m1, affinity: 'left' },
    { type: 'marker', tape, index: 3, marker: m2, affinity: 'right' },
  ]);
  b.apply('A1', action);
  expect(b.range({ tape, start: m1, end: m2 })).toEqual([]);
  expect(b.marker(m1).affinity).toBe('left');
  expect(b.marker(m2).affinity).toBe('right');
  const typing = publish(b, 'B1', [
    { type: 'text', tape, index: b.marker(m2).index, text: '🙂e\u0301' },
  ]);
  a.apply('B1', typing);
  expect(
    a
      .range({ tape, start: m1, end: m2 })
      .map((p) => p.text)
      .join(''),
  ).toBe('🙂e\u0301');
  const before = a.snapshot(tape);
  a.rebuild([
    { key: 'G', body: g },
    { key: 'A1', body: action },
    { key: 'B1', body: typing },
  ]);
  expect(a.snapshot(tape)).toEqual(before);
});

it('rebuilds failed or abandoned native preparation with fresh identity and no compensating deletes', () => {
  const target = cache();
  const g = genesis('old');
  target.apply('G', g);
  const before = target.snapshot(tape);
  const oldClient = target.clientId;
  expect(() =>
    target.prepare('bad', [
      { type: 'text', tape, index: 1, text: 'provisional' },
      { type: 'text', tape, index: -1, text: 'invalid' },
    ]),
  ).toThrow();
  expect(target.snapshot(tape)).toEqual(before);
  expect(target.clientId).not.toBe(oldClient);
  const pending = target.prepare('A1', [{ type: 'text', tape, index: 1, text: 'unpublished' }]);
  const abandonedClient = target.clientId;
  expect(() => target.prepare('A2', [])).toThrow(/Finish/);
  pending.abort();
  expect(target.clientId).not.toBe(abandonedClient);
  expect(target.snapshot(tape)).toEqual(before);
  expect(() => pending.commit()).toThrow(/no longer current/);
  const body = publish(target, 'A1', [{ type: 'text', tape, index: 1, text: 'new' }]);
  expect(birth(body).native.clock).toBe(0);
  const fresh = cache();
  fresh.apply('G', g);
  fresh.apply('A1', body);
  expect(string(fresh)).toBe('newold');
});

it('rebuilds a reduced closure after invalidation and can still accept an old-prefix branch', () => {
  const g = genesis('x');
  const a = cache();
  const b = cache();
  a.apply('G', g);
  b.apply('G', g);
  const a1 = publish(a, 'A1', [{ type: 'text', tape, index: 1, text: 'A' }]);
  const b1 = publish(b, 'B1', [{ type: 'text', tape, index: 2, text: 'B' }]);
  a.rebuild([{ key: 'G', body: g }]);
  expect(string(a)).toBe('x');
  a.apply('B1', b1);
  a.apply('A1', a1);
  b.apply('A1', a1);
  expect(a.snapshot(tape)).toEqual(b.snapshot(tape));
});

it('owns body bytes and resource objects across publication and reads', () => {
  const target = cache();
  const prepared = target.prepare('G', [{ type: 'createTape', tape, start, end }]);
  const valid = structuredClone(prepared.body);
  prepared.body.nativeInsertUpdates[0].fill(0);
  prepared.commit();
  target.apply('G', valid);
  const snapshot = target.snapshot(tape);
  (snapshot.tape as { ordinal: number }).ordinal = 999;
  expect(target.snapshot(tape).tape).toEqual(tape);
  const input = genesis('hi');
  const another = cache();
  another.apply('G', input);
  input.nativeInsertUpdates[0].fill(0);
  expect(() =>
    another.prepare('bad', [
      { type: 'text', tape, index: 1, text: 'provisional' },
      { type: 'text', tape, index: -1, text: 'invalid' },
    ]),
  ).toThrow();
  expect(string(another)).toBe('hi');
});

it('supports multi-tape actions without copying native identities', () => {
  const target = cache();
  const q = id('tape', 10, 1n);
  const qs = id('marker', 11, 1n);
  const qe = id('marker', 12, 1n);
  const body = publish(target, 'G', [
    { type: 'createTape', tape, start, end },
    { type: 'text', tape, index: 1, text: 'P' },
    { type: 'createTape', tape: q, start: qs, end: qe },
    { type: 'text', tape: q, index: 1, text: 'Q' },
  ]);
  const fresh = cache();
  fresh.apply('G', body);
  expect(fresh.snapshot(q)).toEqual(target.snapshot(q));
  expect(string(fresh)).toBe('P');
  expect(() => fresh.locate(q, birth(body).native)).toThrow(/another tape/);
});

describe('Unicode native boundaries', () => {
  it.each(['\ud800', '\udfff', 'a\ud800b'])('rejects ill-formed local input %j', (text) => {
    const target = cache();
    target.apply('G', genesis('ok'));
    expect(() => target.prepare('bad', [{ type: 'text', tape, index: 1, text }])).toThrow(
      /surrogate/,
    );
    expect(string(target)).toBe('ok');
  });
  it('counts UTF-16 units, preserves combining sequences, and refuses half-pair addresses', () => {
    const target = cache();
    const g = genesis('🙂e\u0301');
    target.apply('G', g);
    const range = { tape, ...birth(g).native };
    expect(range.length).toBe(4);
    expect(
      target
        .lookup(range)
        .map((p) => p.text)
        .join(''),
    ).toBe('🙂e\u0301');
    expect(() => target.prepare('bad', [{ type: 'text', tape, index: 2, text: 'X' }])).toThrow(
      /surrogate/,
    );
    expect(() =>
      target.prepare('bad', [
        { type: 'marker', tape, index: 2, marker: id('marker', 99), affinity: 'left' },
      ]),
    ).toThrow(/surrogate/);
    expect(() => target.lookup({ ...range, length: 1 })).toThrow(/surrogate/);
    expect(() => target.locate(tape, { ...range, clock: range.clock + 1 })).toThrow(/surrogate/);
    publish(target, 'valid', [{ type: 'text', tape, index: 4, text: 'X' }]);
    expect(string(target)).toBe('🙂eX\u0301');
  });
});

/** Produce genuine Yjs update events, including forbidden operations, for rejection controls. */
function nativeUpdate(g: NativeBody, change: (doc: Y.Doc, text: Y.Text) => void): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    const text = doc.getText(resourceKey(tape));
    for (const update of g.nativeInsertUpdates) Y.applyUpdate(doc, update);
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    doc.transact(() => change(doc, text));
    return Y.mergeUpdates(updates);
  } finally {
    doc.destroy();
  }
}
function textBody(update: Uint8Array, targetTape = tape): NativeBody {
  return {
    allocations: [],
    nativeInsertUpdates: [update],
    nativeManifest: Y.decodeUpdate(update).structs.flatMap((item) =>
      item instanceof Y.Item && item.content instanceof Y.ContentString
        ? [
            {
              type: 'text' as const,
              tape: targetTape,
              native: { client: item.id.client, clock: item.id.clock, length: item.length },
              text: item.content.str,
            },
          ]
        : [],
    ),
  };
}

describe('native body admission', () => {
  it.each([
    ['deletion', (_doc: Y.Doc, text: Y.Text) => text.delete(1, 1)],
    ['formatting', (_doc: Y.Doc, text: Y.Text) => text.format(1, 1, { bold: true })],
    ['metadata', (doc: Y.Doc) => doc.getMap('metadata').set('evil', 'value')],
    ['nested types', (doc: Y.Doc) => doc.getArray('nested').insert(0, [new Y.Text('value')])],
    ['arbitrary embeds', (_doc: Y.Doc, text: Y.Text) => text.insertEmbed(1, { image: 'evil' })],
    ['unknown root', (doc: Y.Doc) => doc.getText('unallocated').insert(0, 'evil')],
  ] as const)('rejects %s without contaminating the cache', (_name, change) => {
    const g = genesis('text');
    const target = cache();
    target.apply('G', g);
    const before = target.snapshot(tape);
    const client = target.clientId;
    const invalid = nativeUpdate(g, change);
    expect(() => target.apply('bad', textBody(invalid))).toThrow();
    expect(target.snapshot(tape)).toEqual(before);
    expect(target.clientId).toBe(client); // preflight failed, so no mutation or rebuild needed
    publish(target, 'next', [{ type: 'text', tape, index: 1, text: 'ok' }]);
    expect(string(target)).toBe('oktext');
  });

  it('rejects a remote insertion between surrogate halves before Yjs can split them', () => {
    const g = genesis('🙂');
    const target = cache();
    target.apply('G', g);
    const invalid = nativeUpdate(g, (_doc, text) => text.insert(2, 'X'));
    expect(() => target.apply('bad', textBody(invalid))).toThrow(/surrogate/);
    expect(string(target)).toBe('🙂');
  });

  it('rebuilds after an integrated body violates permanent endpoints', () => {
    const g = genesis('text');
    const target = cache();
    target.apply('G', g);
    const before = target.snapshot(tape);
    const client = target.clientId;
    const invalid = nativeUpdate(g, (_doc, text) => text.insert(0, 'outside'));
    expect(() => target.apply('bad', textBody(invalid))).toThrow(/outside permanent/);
    expect(target.snapshot(tape)).toEqual(before);
    expect(target.clientId).not.toBe(client);
    const next = publish(target, 'next', [{ type: 'text', tape, index: 1, text: 'ok' }]);
    const fresh = cache();
    fresh.apply('G', g);
    fresh.apply('next', next);
    expect(string(fresh)).toBe('oktext');
  });

  it('rejects missing native prerequisites while independent ready progress continues', () => {
    const g = genesis('x');
    const source = cache();
    source.apply('G', g);
    const first = publish(source, 'A1', [{ type: 'text', tape, index: 1, text: 'one' }]);
    const second = publish(source, 'A2', [{ type: 'text', tape, index: 2, text: 'two' }]);
    const target = cache();
    target.apply('G', g);
    expect(() => target.apply('A2', second)).toThrow(/clock prefix/);
    publish(target, 'B1', [{ type: 'text', tape, index: 2, text: 'B' }]);
    target.apply('A1', first);
    target.apply('A2', second);
    expect(string(target)).toBe('otwonexB');
  });

  it('rejects dependencies from an unmaterialized client, not just a missing clock prefix', () => {
    const g = genesis('x');
    const a = cache();
    const b = cache();
    a.apply('G', g);
    b.apply('G', g);
    const a1 = publish(a, 'A1', [{ type: 'text', tape, index: 1, text: 'a' }]);
    b.apply('A1', a1);
    const b1 = publish(b, 'B1', [{ type: 'text', tape, index: 2, text: 'b' }]);
    const c = cache();
    c.apply('G', g);
    expect(() => c.apply('B1', b1)).toThrow(/Missing native origin/);
    expect(string(c)).toBe('x');
    c.apply('A1', a1);
    c.apply('B1', b1);
    expect(string(c)).toBe('abx');
  });

  it('rejects state-vector bodies containing prior history and duplicate structs', () => {
    const g = genesis('x');
    const target = cache();
    target.apply('G', g);
    const own = nativeUpdate(g, (_doc, text) => text.insert(1, 'new'));
    const polluted = textBody(Y.mergeUpdates([...g.nativeInsertUpdates, own]));
    expect(() => target.apply('bad', polluted)).toThrow(/overlapping IDs/);
    const body = textBody(own);
    expect(() => target.apply('bad', { ...body, nativeInsertUpdates: [own, own] })).toThrow(
      /overlapping IDs/,
    );
    target.apply('good', body);
    expect(string(target)).toBe('newx');
  });

  it.each(['missing', 'extra', 'text', 'length', 'id', 'tape'] as const)(
    'rejects %s manifest mismatch',
    (change) => {
      const g = genesis('x');
      const a = cache();
      a.apply('G', g);
      const body = publish(a, 'A1', [{ type: 'text', tape, index: 1, text: 'abc' }]);
      const entry = birth(body);
      const manifest =
        change === 'missing'
          ? []
          : change === 'extra'
            ? [entry, entry]
            : [
                {
                  ...entry,
                  ...(change === 'text' ? { text: 'abd' } : {}),
                  ...(change === 'length' ? { native: { ...entry.native, length: 2 } } : {}),
                  ...(change === 'id'
                    ? { native: { ...entry.native, client: entry.native.client + 1 } }
                    : {}),
                  ...(change === 'tape' ? { tape: id('tape', 999) } : {}),
                },
              ];
      const b = cache();
      b.apply('G', g);
      expect(() => b.apply('A1', { ...body, nativeManifest: manifest })).toThrow(
        /manifest differs/,
      );
      expect(string(b)).toBe('x');
      b.apply('A1', body);
      expect(string(b)).toBe('abcx');
    },
  );

  it('requires exact marker allocation identity, affinity and distinct sentinel allocations', () => {
    const g = genesis();
    for (const transform of [
      (body: NativeBody) => ({
        ...body,
        allocations: body.allocations.filter((a) => a.type !== 'marker'),
      }),
      (body: NativeBody) => ({
        ...body,
        allocations: body.allocations.map((a) => (a.type === 'tape' ? { ...a, end: a.start } : a)),
      }),
      (body: NativeBody) => ({
        ...body,
        allocations: body.allocations.map((a) =>
          a.type === 'marker' ? { ...a, native: { ...a.native, clock: a.native.clock + 10 } } : a,
        ),
      }),
      (body: NativeBody) => ({
        ...body,
        allocations: body.allocations.map((a) =>
          a.type === 'marker' ? { ...a, affinity: 'other' as 'left' } : a,
        ),
      }),
    ]) {
      const target = cache();
      expect(() => target.apply('G', transform(g))).toThrow();
      target.apply('G', g);
      expect(string(target)).toBe('');
    }
  });

  it('rejects a changed key payload, malformed bytes and reuse of native IDs under a new key', () => {
    const target = cache();
    const g = genesis('x');
    target.apply('G', g);
    expect(() => target.apply('G', { ...g, nativeManifest: [] })).toThrow(/Conflicting/);
    expect(() => target.apply('other', g)).toThrow(/Duplicate/);
    expect(() =>
      target.apply('bad', {
        allocations: [],
        nativeInsertUpdates: [new Uint8Array([255])],
        nativeManifest: [],
      }),
    ).toThrow();
    expect(string(target)).toBe('x');
  });

  it('keeps the valid live cache if explicit reconstruction fails and invalidates stale preparations on success', () => {
    const target = cache();
    const g = genesis('x');
    target.apply('G', g);
    const pending = target.prepare('A1', [{ type: 'text', tape, index: 1, text: 'a' }]);
    expect(() => target.rebuild([{ key: 'bad', body: { ...g, nativeManifest: [] } }])).toThrow();
    pending.commit();
    expect(string(target)).toBe('ax');
    const next = target.prepare('A2', []);
    target.rebuild([{ key: 'G', body: g }]);
    expect(() => next.abort()).toThrow(/no longer current/);
    expect(string(target)).toBe('x');
  });
});

it('captures interleaved action-local strings and markers without native deletion or formatting', () => {
  const remove = vi.spyOn(Y.Text.prototype, 'delete');
  const format = vi.spyOn(Y.Text.prototype, 'format');
  try {
    const target = cache();
    const g = genesis('original');
    target.apply('G', g);
    const marker = id('marker', 3, 1n);
    const action = publish(target, 'A1', [
      { type: 'text', tape, index: 1, text: 'abc' },
      { type: 'marker', tape, index: 2, marker, affinity: 'right' },
      { type: 'text', tape, index: 3, text: 'XYZ' },
      { type: 'text', tape, index: 2, text: 'before' },
    ]);
    const fresh = cache();
    fresh.apply('G', g);
    fresh.apply('A1', action);
    expect(string(fresh)).toBe('abeforeXYZbcoriginal');
    expect(fresh.snapshot(tape)).toEqual(target.snapshot(tape));
    expect(remove).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
  } finally {
    remove.mockRestore();
    format.mockRestore();
  }
});

it('preserves all native text and marker IDs across seeded independent-client insertion traces', () => {
  // This exercises only native insertion convergence. It is not the semantic fault harness.
  for (let seed = 1; seed <= 8; seed++) {
    let random = seed;
    const next = (max: number) => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random % max;
    };
    const g = genesis('🙂e\u0301');
    const peers = [cache(), cache(), cache()];
    const actions: { key: string; body: NativeBody }[][] = [[], [], []];
    for (const [peerIndex, peer] of peers.entries()) {
      peer.apply('G', g);
      for (let n = 0; n < 24; n++) {
        const parts = peer.snapshot(tape).parts;
        const gaps = [1];
        for (const part of parts) {
          if (part.type === 'marker') {
            if (resourceKey(part.marker) !== resourceKey(end)) gaps.push(part.index + 1);
          } else
            for (let i = 1; i <= part.text.length; i++) {
              const unit = part.text.charCodeAt(i - 1);
              if (!(unit >= 0xd800 && unit <= 0xdbff)) gaps.push(part.index + i);
            }
        }
        const index = gaps[next(gaps.length)];
        const key = `P${peerIndex}/${n}`;
        const operation: NativeInsertion =
          n % 5 === 0
            ? {
                type: 'marker',
                tape,
                index,
                marker: id('marker', 100 + peerIndex * 100 + n, 1n),
                affinity: next(2) ? 'left' : 'right',
              }
            : { type: 'text', tape, index, text: ['x', '🙂', 'e\u0301', '\n'][next(4)] };
        actions[peerIndex].push({ key, body: publish(peer, key, [operation]) });
      }
    }
    for (const peer of peers) {
      const cursors = [0, 0, 0];
      while (cursors.some((cursor, i) => cursor < actions[i].length)) {
        const available = cursors.flatMap((cursor, i) => (cursor < actions[i].length ? [i] : []));
        const from = available[next(available.length)];
        const action = actions[from][cursors[from]++];
        peer.apply(action.key, action.body);
        if (next(2)) peer.apply(action.key, action.body);
      }
    }
    const snapshot = peers[0].snapshot(tape);
    expect(peers[1].snapshot(tape), `seed ${seed}`).toEqual(snapshot);
    expect(peers[2].snapshot(tape), `seed ${seed}`).toEqual(snapshot);
    const replay = cache();
    replay.rebuild([{ key: 'G', body: g }, ...actions.flat()]);
    expect(replay.snapshot(tape), `seed ${seed} replay`).toEqual(snapshot);
    const textIds = snapshot.parts.flatMap((p) =>
      p.type === 'text'
        ? Array.from(
            { length: p.text.length },
            (_, i) => `${p.native.client}:${p.native.clock + i}`,
          )
        : [],
    );
    expect(new Set(textIds).size).toBe(textIds.length);
  }
});
