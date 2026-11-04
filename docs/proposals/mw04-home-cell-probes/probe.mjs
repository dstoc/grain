import './resolve-ts.mjs';
import assert from 'node:assert/strict';
const { NativeTapeCache } = await import('../../../src/markdown/multiwriter/text/cache.ts');
const { actorId } = await import('../../../src/markdown/multiwriter/contracts.ts');

// Native encoding controls only. This file does not assign ownership or run the reducer.
const caches = [];
const cache = () => {
  const value = new NativeTapeCache();
  caches.push(value);
  return value;
};
const id = (kind, ordinal, actor = 0, sequence = 1n) => ({
  kind,
  ordinal,
  birth: actor
    ? { type: 'action', action: { actor: actorId(actor.toString(16).padStart(32, '0')), sequence } }
    : { type: 'genesis', genesisId: 'home-probe' },
});
const tape = (actor, sequence = 1n) => ({
  tape: id('tape', 0, actor, sequence),
  start: id('marker', 1, actor, sequence),
  end: id('marker', 2, actor, sequence),
});
const publish = (target, key, operations) => {
  const prepared = target.prepare(key, operations);
  prepared.commit();
  return prepared.body;
};
const read = (target, range) =>
  target
    .range(range)
    .map((part) => part.text)
    .join('');
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};
const permutations = (items) =>
  items.length < 2
    ? [items]
    : items.flatMap((item, i) =>
        permutations(items.filter((_, index) => index !== i)).map((tail) => [item, ...tail]),
      );
const manifests = {};
try {
  const p = tape(0);
  const left = id('marker', 3);
  const right = id('marker', 4);
  const g = publish(cache(), 'G', [
    { type: 'createTape', ...p },
    { type: 'marker', tape: p.tape, index: 1, marker: left, affinity: 'left' },
    { type: 'text', tape: p.tape, index: 2, text: 'abcdef' },
    { type: 'marker', tape: p.tape, index: 8, marker: right, affinity: 'right' },
  ]);
  manifests.G = g;
  const authors = [cache(), cache(), cache()];
  authors.forEach((author) => author.apply('G', g));
  check('three independent common-genesis native authors', () =>
    assert.equal(new Set(authors.map((author) => author.clientId)).size, 3),
  );
  const aCut = id('marker', 3, 1);
  const bCut = id('marker', 3, 2);
  const cStart = id('marker', 0, 3);
  const cEnd = id('marker', 1, 3);
  const homes = [tape(1), tape(2)];
  const bodies = {
    A1: publish(authors[0], 'A1', [
      { type: 'marker', tape: p.tape, index: 6, marker: aCut, affinity: 'right' },
      { type: 'createTape', ...homes[0] },
    ]),
    B1: publish(authors[1], 'B1', [
      { type: 'marker', tape: p.tape, index: 4, marker: bCut, affinity: 'right' },
      { type: 'createTape', ...homes[1] },
    ]),
    C1: publish(authors[2], 'C1', [
      { type: 'marker', tape: p.tape, index: 3, marker: cStart, affinity: 'left' },
      { type: 'marker', tape: p.tape, index: 9, marker: cEnd, affinity: 'right' },
    ]),
  };
  Object.assign(manifests, bodies);
  check('independent authors retain ef, cdef and bcdef captures', () => {
    assert.equal(read(authors[0], { tape: p.tape, start: aCut, end: right }), 'ef');
    assert.equal(read(authors[1], { tape: p.tape, start: bCut, end: right }), 'cdef');
    assert.equal(read(authors[2], { tape: p.tape, start: cStart, end: cEnd }), 'bcdef');
  });
  let expected;
  for (const order of permutations(Object.keys(bodies))) {
    const peer = cache();
    peer.apply('G', g);
    order.forEach((key) => peer.apply(key, bodies[key]));
    const snapshots = [p, ...homes].map((home) => peer.snapshot(home.tape));
    if (!expected) expected = snapshots;
    check(`${order.join('/')} exact reconstruction of all three tapes`, () =>
      assert.deepEqual(snapshots, expected),
    );
    check(`${order.join('/')} B home is distinct and outside C captured tape`, () => {
      assert.notDeepEqual(homes[1].tape, p.tape);
      assert.equal(read(peer, homes[1]), '');
      assert.equal(peer.snapshot(homes[1].tape).parts.length, 2);
    });
  }
  // Two disconnected peers type into B's empty home. Each brackets its own string.
  const peers = [cache(), cache()];
  peers.forEach((peer) => {
    peer.apply('G', g);
    Object.entries(bodies).forEach(([key, body]) => peer.apply(key, body));
  });
  const typed = peers.map((peer, i) => {
    const home = homes[1];
    const start = id('marker', 0, i + 4);
    const end = id('marker', 1, i + 4);
    const text = i ? 'y' : '😀';
    return publish(peer, `T${i}`, [
      { type: 'marker', tape: home.tape, index: 1, marker: start, affinity: 'left' },
      { type: 'text', tape: home.tape, index: 2, text },
      { type: 'marker', tape: home.tape, index: 2 + text.length, marker: end, affinity: 'right' },
    ]);
  });
  manifests.T0 = typed[0];
  manifests.T1 = typed[1];
  peers[0].apply('T1', typed[1]);
  peers[1].apply('T0', typed[0]);
  check('concurrent bracketed home typing converges with exact native identities', () =>
    assert.deepEqual(peers[0].snapshot(homes[1].tape), peers[1].snapshot(homes[1].tape)),
  );
  const home = homes[1];
  const snapshot = peers[0].snapshot(home.tape);
  const markers = snapshot.parts.filter((part) => part.type === 'marker');
  check('concurrent strings retain empty boundary-adjacent home cells', () => {
    assert.equal(read(peers[0], { ...home, end: markers[1].marker }), '');
    assert.equal(read(peers[0], { ...home, start: markers.at(-2).marker }), '');
    const text = read(peers[0], home);
    assert(text === '😀y' || text === 'y😀');
  });
  // Native feasibility of full-content recapture with endpoints strictly inside home.
  const captureStart = id('marker', 0, 6);
  const captureEnd = id('marker', 1, 6);
  const captureBody = publish(peers[0], 'capture', [
    { type: 'marker', tape: home.tape, index: 1, marker: captureStart, affinity: 'left' },
    {
      type: 'marker',
      tape: home.tape,
      index: snapshot.length,
      marker: captureEnd,
      affinity: 'right',
    },
  ]);
  manifests.capture = captureBody;
  const captured = { tape: home.tape, start: captureStart, end: captureEnd };
  check('interior recapture covers all current home text, leaving empty edge cells', () => {
    assert.equal(read(peers[0], captured), read(peers[0], home));
    assert.equal(read(peers[0], { ...home, end: captureStart }), '');
    assert.equal(read(peers[0], { ...home, start: captureEnd }), '');
  });
  const xStart = id('marker', 0, 7);
  const xEnd = id('marker', 1, 7);
  const fallback = publish(peers[0], 'fallback', [
    {
      type: 'marker',
      tape: home.tape,
      index: peers[0].marker(home.end).index,
      marker: xStart,
      affinity: 'left',
    },
    { type: 'text', tape: home.tape, index: peers[0].marker(home.end).index + 1, text: 'z' },
    {
      type: 'marker',
      tape: home.tape,
      index: peers[0].marker(home.end).index + 2,
      marker: xEnd,
      affinity: 'right',
    },
  ]);
  manifests.fallback = fallback;
  check('fresh bracketed fallback lies outside earlier interior capture', () => {
    assert.equal(read(peers[0], captured).includes('z'), false);
    assert.equal(read(peers[0], { tape: home.tape, start: xStart, end: xEnd }), 'z');
    assert.equal(read(peers[0], { ...home, start: xEnd }), '');
  });
  check('negative control: whole-tape capture includes fallback text', () =>
    assert.equal(read(peers[0], home).includes('z'), true),
  );
  // Complete ready native bodies must reconstruct the exact final tape.
  for (const prefix of permutations(['T0', 'T1'])) {
    const order = [...prefix, 'capture', 'fallback'];
    const peer = cache();
    peer.apply('G', g);
    Object.entries(bodies).forEach(([key, body]) => peer.apply(key, body));
    order.forEach((key) => peer.apply(key, manifests[key]));
    order.forEach((key) => peer.apply(key, manifests[key]));
    check(`${order.join('/')} duplicate/ready native reconstruction`, () =>
      assert.deepEqual(peer.snapshot(home.tape), peers[0].snapshot(home.tape)),
    );
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        scope:
          'native encoding only; no ownership assignments, layout reduction, history or MW-08 proof',
        checks: checks.length,
        passed: checks,
        manifests,
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  );
} finally {
  caches.forEach((value) => value.destroy());
}
