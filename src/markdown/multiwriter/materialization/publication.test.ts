import { afterEach, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { compareBytes } from '../actions/cbor.js';
import { actionKey } from '../actions/references.js';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeView } from '../ingest/publication.js';
import { MaterializedPublication } from './publication.js';

afterEach(() => vi.restoreAllMocks());
const open = (genesis = commandGenesis(), bytes?: Uint8Array) =>
  commandReplica(genesis, bytes, 'materialized');
function applied(result: ReturnType<ReturnType<typeof open>['editor']['edit']>) {
  if (result.status !== 'applied') throw new Error('Expected applied edit');
  return result;
}
function materializer(p: ReturnType<typeof open>) {
  const publication = p.document.publication;
  if (!(publication instanceof MaterializedPublication)) throw new Error('Wrong reader');
  return publication;
}
function equalReference(p: ReturnType<typeof open>) {
  const canonical = p.document.store.encodeUpdate();
  const cold = commandReplica(p.genesis, canonical);
  try {
    expect(p.observe()).toEqual(cold.observe());
    expect(compareBytes(p.document.store.encodeUpdate(), canonical)).toBe(0);
  } finally {
    cold.close();
  }
}

test('no-change and duplicate refresh preserve the complete published tuple', () => {
  const p = open();
  try {
    const publication = p.document.publication;
    const before = publication.status().publication!;
    const counts = materializer(p).diagnostics();
    expect(p.editor.refresh()).toBe(before);
    p.document.store.applyUpdate(p.document.store.encodeUpdate());
    expect(p.editor.refresh()).toBe(before);
    expect(materializer(p).diagnostics()).toEqual({
      ...counts,
      unchangedRefreshes: counts.unchangedRefreshes + 2,
    });
    expect(Object.isFrozen(before.native)).toBe(true);
    equalReference(p);
  } finally {
    p.close();
  }
});

for (const size of [10, 150]) {
  test(`native append indexes one tape in ${size} paragraphs and never reapplies old bodies`, () => {
    const p = open(commandGenesis(Array.from({ length: size }, () => 'abc').join('\n\n')));
    try {
      for (let i = 0; i < 3; i++) {
        const before = materializer(p).diagnostics();
        applied(
          p.editor.edit({ local: 'cost', group: BigInt(i + 1) }, insertText, {
            nodeId: p.handle(p.nodes()[0]),
            from: 1,
            text: 'X',
          }),
        );
        const after = materializer(p).diagnostics();
        expect(after.nativeBodiesIntegrated - before.nativeBodiesIntegrated).toBe(1);
        expect(after.tapesIndexed - before.tapesIndexed).toBe(1);
        expect(after.nativeRebuilds).toBe(0);
        equalReference(p);
      }
    } finally {
      p.close();
    }
  }, 60000);
}

test('all old native reads survive candidate integration, cancellation, commit and eviction', () => {
  const genesis = commandGenesis('a😀bc');
  const a = commandReplica(genesis),
    p = open(genesis);
  const carriers: Uint8Array[] = [];
  const stop = a.document.store.onUpdate((bytes) => carriers.push(bytes));
  try {
    for (let i = 0; i < 2; i++)
      applied(
        a.editor.edit({ local: 'A', group: BigInt(i + 1) }, insertText, {
          nodeId: a.handle(a.nodes()[0]),
          from: i,
          text: 'X',
        }),
      );
    const old = p.document.publication.status().publication!;
    const tape = genesis.body.allocations.find((v) => v.type === 'tape')!;
    const birth = genesis.body.nativeManifest.find((v) => v.type === 'text')!;
    if (tape.type !== 'tape' || birth.type !== 'text') throw new Error();
    const range = { tape: birth.tape, ...birth.native };
    const read = (n: NativeView) => ({
      snapshot: n.snapshot(tape.id),
      marker: n.marker(tape.end),
      range: n.range({ tape: tape.id, start: tape.start, end: tape.end }),
      lookup: n.lookup(range),
      locate: n.locate(range.tape, range),
      bytes: n.encodeState(),
    });
    const before = read(old.native);
    let integrated = false;
    const candidateKey = actionKey(a.document.store.snapshot().ready[0].id);
    const apply = NativeTapeCache.prototype.applySteps;
    const spy = vi.spyOn(NativeTapeCache.prototype, 'applySteps').mockImplementation(function* (
      this: NativeTapeCache,
      key,
      body,
    ) {
      yield* apply.call(this, key, body);
      if (key === candidateKey) integrated = true;
    });
    p.document.store.applyUpdate(carriers[0]);
    let work = p.document.publication.refresh(0);
    for (let i = 0; !integrated && i < 200000; i++) {
      if (work.state !== 'deferred') throw new Error('Published before probe');
      work = work.continuation.resume(1);
    }
    expect(integrated).toBe(true);
    expect(work.state).toBe('deferred');
    expect(read(old.native)).toEqual(before);
    p.document.store.applyUpdate(carriers[1]);
    if (work.state !== 'deferred') throw new Error();
    expect(() => work.continuation.resume(1)).toThrow(/invalidated/);
    spy.mockRestore();
    expect(read(old.native)).toEqual(before);
    p.editor.refresh();
    expect(materializer(p).diagnostics().discardedNativeCandidates).toBeGreaterThan(0);
    expect(read(old.native)).toEqual(before);
    materializer(p).evict();
    expect(read(old.native)).toEqual(before);
    applied(
      p.editor.edit({ local: 'P', group: 1n }, insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 0,
        text: 'Z',
      }),
    );
    equalReference(p);
    expect(read(old.native)).toEqual(before);
  } finally {
    stop();
    a.close();
    p.close();
  }
});

test('late fork removes native bodies and descendants while independent peer work survives', () => {
  const genesis = commandGenesis();
  const a = commandReplica(genesis),
    b = commandReplica(genesis),
    p = open(genesis);
  try {
    const first = applied(
      a.editor.edit({ local: 'A', group: 1n }, insertText, {
        nodeId: a.handle(a.nodes()[0]),
        from: 0,
        text: 'X',
      }),
    );
    applied(
      a.editor.edit({ local: 'A', group: 2n }, insertText, {
        nodeId: a.handle(a.nodes()[0]),
        from: 1,
        text: 'Y',
      }),
    );
    applied(
      b.editor.edit({ local: 'B', group: 1n }, insertText, {
        nodeId: b.handle(b.nodes()[0]),
        from: 0,
        text: 'Z',
      }),
    );
    p.receive(a.document.store.encodeUpdate());
    p.receive(b.document.store.encodeUpdate());
    const old = p.document.publication.status().publication!;
    const oldBytes = old.native.encodeState();
    p.document.store.append({ ...first.envelope, groupId: { ...first.group, sequence: 999n } });
    p.editor.refresh();
    expect(materializer(p).diagnostics().nativeRebuilds).toBe(1);
    expect(compareBytes(old.native.encodeState(), oldBytes)).toBe(0);
    expect(p.markdown()).toBe('Zabcdef\n');
    equalReference(p);
  } finally {
    a.close();
    b.close();
    p.close();
  }
});

test('split undo/redo, retained peer insertion, reversed carrier and cold reopen equal the reference', () => {
  const genesis = commandGenesis();
  const a = open(genesis),
    b = open(genesis);
  const carriers: Uint8Array[] = [];
  const stop = a.document.store.onUpdate((bytes) => carriers.push(bytes));
  try {
    const split = applied(
      a.editor.edit({ local: 'A', group: 1n }, insertParagraph, {
        nodeId: a.handle(a.nodes()[0]),
        from: 3,
      }),
    );
    b.receive(a.document.store.encodeUpdate());
    applied(
      b.editor.edit({ local: 'B', group: 1n }, insertText, {
        nodeId: b.handle(b.nodes()[1]),
        from: 1,
        text: '😀',
      }),
    );
    a.receive(b.document.store.encodeUpdate());
    equalReference(a);
    const before = a.observe();
    const undo = control(a, split, false);
    equalReference(a);
    expect(a.nodes().map((n) => n.content)).toEqual(['abcd😀ef']);
    expect(compareBytes(a.observe().native, before.native)).toBe(0);
    control(a, split, true, undo);
    equalReference(a);
    const p = open(genesis);
    try {
      for (const bytes of [...carriers].reverse()) {
        p.receive(bytes);
        equalReference(p);
      }
      p.receive(b.document.store.encodeUpdate());
      equalReference(p);
      expect(p.observe()).toEqual(a.observe());
      const reopened = open(genesis, p.document.store.encodeUpdate());
      try {
        expect(reopened.observe()).toEqual(a.observe());
      } finally {
        reopened.close();
      }
    } finally {
      p.close();
    }
  } finally {
    stop();
    a.close();
    b.close();
  }
});

test('a reducer failure after native integration preserves the old tuple and retries without reintegration', () => {
  const genesis = commandGenesis();
  const source = commandReplica(genesis),
    target = open(genesis);
  const tape = genesis.body.allocations.find((a) => a.type === 'tape')!;
  if (tape.type !== 'tape') throw new Error();
  let fail = false;
  const publication = new MaterializedPublication(
    target.document.store,
    genesis.body,
    function* (_actions, native) {
      yield;
      if (fail) throw new Error('semantic reducer failed');
      return native
        .range({ tape: tape.id, start: tape.start, end: tape.end })
        .map((p) => p.text)
        .join('');
    },
  );
  const refresh = () => {
    let result = publication.refresh();
    while (result.state === 'deferred') result = result.continuation.resume();
    return result.value;
  };
  try {
    const old = refresh(),
      oldBytes = old.native.encodeState();
    applied(
      source.editor.edit({ local: 'source', group: 1n }, insertText, {
        nodeId: source.handle(source.nodes()[0]),
        from: 0,
        text: 'X',
      }),
    );
    target.document.store.applyUpdate(source.document.store.encodeUpdate());
    const canonical = target.document.store.encodeUpdate();
    fail = true;
    expect(refresh).toThrow('semantic reducer failed');
    expect(publication.status()).toMatchObject({ stale: true, canAuthor: false });
    expect(publication.status().publication).toBe(old);
    expect(old.value).toBe('abcdef');
    expect(compareBytes(old.native.encodeState(), oldBytes)).toBe(0);
    const beforeRetry = publication.diagnostics();
    fail = false;
    expect(refresh().value).toBe('Xabcdef');
    expect(publication.diagnostics().nativeBodiesIntegrated).toBe(
      beforeRetry.nativeBodiesIntegrated,
    );
    expect(compareBytes(old.native.encodeState(), oldBytes)).toBe(0);
    expect(compareBytes(target.document.store.encodeUpdate(), canonical)).toBe(0);
  } finally {
    publication.destroy();
    source.close();
    target.close();
  }
});
