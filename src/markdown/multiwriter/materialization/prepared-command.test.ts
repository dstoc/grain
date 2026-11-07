import { afterEach, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import {
  enter,
  deleteBackwardAtStart,
  insertText,
  deleteBlocks,
  RetainedEditError,
} from '../authoring/index.js';
import { captureDiagnostics } from '../diagnostics.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import { textPoint, resolveAddress } from '../projection/addresses.js';
import type { PreparedLocalPublication } from '../authoring/document.js';
import { MaterializedPublication } from './publication.js';
import { MaterializedProjection } from './projection.js';
import type { projectMarkdown } from '../projection/project.js';

afterEach(() => vi.restoreAllMocks());

for (const size of [10, 150])
  for (const deleted of [false, true])
    test(`managed Enter/Backspace shares exact candidate roots, selection and typing (${size}/${deleted})`, () => {
      const genesis = commandGenesis(
        Array.from({ length: size }, (_, i) => `p${i}abcdef`).join('\n\n'),
      );
      const p = commandReplica(genesis, undefined, 'materialized'),
        oracle = createMaterializationOracle();
      try {
        if (!('prepareLocalAction' in p.document)) throw new Error('Expected materialized');
        const document = p.document;
        if (deleted)
          p.editor
            .session('delete')
            .edit(deleteBlocks, { nodeIds: [p.handle(p.nodes()[size - 2])] });
        const held = document.publication.status().publication!,
          heldNative = held.native.encodeState();
        const heldView = structuredClone(held.value.view),
          tail = p.nodes().at(-1)!;
        const address = textPoint(tail, 2, 'left').address;
        const session = p.editor.session('commands'),
          unrelated = p.editor.session('unrelated');
        const prepare = document.prepareLocalAction.bind(document);
        const staged: { candidate?: PreparedLocalPublication<ReturnType<typeof projectMarkdown>> } =
          {};
        const readCandidate = () => staged.candidate;
        vi.spyOn(document, 'prepareLocalAction').mockImplementation(
          (action) => (staged.candidate = prepare(action)),
        );
        const step = (operation: () => { status?: string; state?: string }) => {
          staged.candidate = undefined;
          const { value, report } = captureDiagnostics(operation);
          expect(value.status ?? value.state).toBe('applied');
          const candidate = readCandidate();
          if (candidate) {
            expect(document.publication.status().publication).toBe(candidate.publication);
            expect(report.work['publication/command.candidatesPublished']).toBe(1);
            expect(report.work['author/command.candidatesPrepared']).toBe(1);
            // Compiler queries, exact-author certification and candidate application
            // are different obligations. No consumer reconstructs a full result.
            for (const purpose of ['author', 'staging', 'publication'])
              for (const name of [
                'draft.fullConstructionTrees',
                'compiler.fullConstructionTrees',
                'projection.fullProjectors',
                'provenance.fullReconstructions',
                'command.retainedEntriesEnumerated',
              ])
                expect(report.work[`${purpose}/${name}`] ?? 0, `${purpose}/${name}`).toBe(0);
          }
          oracle.check(document, genesis);
          expect(p.nodes().at(-1)).toBe(tail);
          expect(held.value.view).toEqual(heldView);
          expect(compareBytes(heldNative, held.native.encodeState())).toBe(0);
          expect(resolveAddress(address, held.value.ownership, held.value.visibility).state).toBe(
            'available',
          );
          return value;
        };
        const select = (index: number, offset: number) => {
          const nodeId = p.handle(p.nodes()[index]);
          return {
            anchor: { nodeId, offset, affinity: 'right' as const },
            focus: { nodeId, offset, affinity: 'right' as const },
          };
        };
        step(() =>
          session.edit(
            enter,
            { nodeId: p.handle(p.nodes()[0]), from: 4 },
            { selectionBefore: select(0, 4) },
          ),
        );
        expect(
          p
            .nodes()
            .slice(0, 2)
            .map((n) => n.content),
        ).toEqual(['p0ab', 'cdef']);
        step(() =>
          session.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[0]), from: 1, text: 'L' },
            { typing: false },
          ),
        );
        step(() =>
          session.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[1]), from: 1, text: 'R' },
            { typing: false },
          ),
        );
        const rightId = resourceKey(p.nodes()[1].origin.representative);
        step(() =>
          session.edit(
            deleteBackwardAtStart,
            { nodeId: p.handle(p.nodes()[1]) },
            { selectionBefore: select(1, 0) },
          ),
        );
        expect(p.nodes()[0].content).toBe('pL0abcRdef');
        step(() =>
          unrelated.edit(insertText, { nodeId: p.handle(p.nodes()[3]), from: 1, text: 'U' }),
        );
        const undo = session.undo();
        expect(undo).toMatchObject({
          state: 'applied',
          restoration: { state: 'exact', focus: { offset: 0 } },
        });
        expect(resourceKey(p.nodes()[1].origin.representative)).toBe(rightId);
        oracle.check(document, genesis);
        const redo = session.redo();
        expect(redo).toMatchObject({
          state: 'applied',
          restoration: { state: 'exact', focus: { offset: 5 } },
        });
        oracle.check(document, genesis);
        step(() =>
          session.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[0]), from: 5, text: '!' },
            { typing: false },
          ),
        );
      } finally {
        oracle.destroy();
        p.close();
      }
    }, 20_000);

test('payload changes and intervening facts invalidate a private candidate before append', () => {
  const genesis = commandGenesis('abcdef\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized');
  try {
    if (!('prepareLocalAction' in p.document)) throw new Error('Expected materialized');
    const document = p.document,
      prepare = document.prepareLocalAction.bind(document);
    const before = document.store.encodeUpdate(),
      held = document.publication.status().publication;
    vi.spyOn(document, 'prepareLocalAction').mockImplementation((action) => {
      const result = prepare(action)!;
      Object.assign(action, { lamport: action.lamport + 1n });
      return result;
    });
    expect(() =>
      p.editor.session().edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
    ).toThrow('no longer current');
    expect(compareBytes(before, document.store.encodeUpdate())).toBe(0);
    expect(document.publication.status().publication).toBe(held);
    vi.restoreAllMocks();
    expect(p.editor.session().edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 }).status).toBe(
      'applied',
    );
  } finally {
    p.close();
  }
});

test('retained observer failure recovers the same candidate and registers history once', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  try {
    const session = p.editor.session('retained');
    const stop = p.document.store.onUpdate(() => {
      throw new Error('storage observer');
    });
    expect(() => session.edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 })).toThrow(
      RetainedEditError,
    );
    stop();
    expect(p.document.store.snapshot().ready).toHaveLength(1);
    p.editor.refresh();
    expect(
      p
        .nodes()
        .slice(0, 2)
        .map((n) => n.content),
    ).toEqual(['ab', 'cdef']);
    expect(session.undo().state).toBe('applied');
    expect(session.undo().state).toBe('empty');
    expect(session.redo().state).toBe('applied');
    expect(
      p.document.store
        .snapshot()
        .ready.filter((a) => a.effects.some((e) => e.type === 'SplitFlow')),
    ).toHaveLength(1);
  } finally {
    p.close();
  }
});

test('reentrant ingress during private C preparation cannot publish an unappended native body', () => {
  const genesis = commandGenesis('abcdef\n\ntail');
  const p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis),
    oracle = createMaterializationOracle();
  try {
    peer.editor.edit({ local: 'remote', group: 1n }, insertText, {
      nodeId: peer.handle(peer.nodes()[1]),
      from: 1,
      text: 'R',
    });
    const prepare = MaterializedProjection.prototype.prepare;
    let delivered = false;
    vi.spyOn(MaterializedProjection.prototype, 'prepare').mockImplementation(function* (
      this: MaterializedProjection,
      ...args: Parameters<typeof prepare>
    ) {
      const candidate = yield* prepare.apply(this, args);
      if (args[5] && !delivered) {
        delivered = true;
        p.receive(peer.document.store.encodeUpdate());
      }
      return candidate;
    });
    expect(() =>
      p.editor.session('local').edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
    ).toThrow('invalidated');
    vi.restoreAllMocks();
    expect(delivered).toBe(true);
    expect(p.document.store.snapshot().ready).toHaveLength(1);
    expect(p.nodes().map((n) => n.content)).toEqual(['abcdef', 'tRail']);
    oracle.check(p.document, genesis);
    expect(
      p.editor.session('local').edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 }).status,
    ).toBe('applied');
    oracle.check(p.document, genesis);
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('a valid remote body cannot prepare against a different merged publication', () => {
  const genesis = commandGenesis('abcdef\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis),
    oracle = createMaterializationOracle();
  try {
    p.editor
      .session('local')
      .edit(insertText, { nodeId: p.handle(p.nodes()[1]), from: 1, text: 'L' });
    const remote = peer.editor
      .session('remote')
      .edit(enter, { nodeId: peer.handle(peer.nodes()[0]), from: 2 });
    if (remote.status !== 'applied' || !('prepareLocalAction' in p.document))
      throw new Error('Expected structural action');
    const document = p.document;
    const held = document.publication.status().publication;
    const { value, report } = captureDiagnostics(() =>
      document.prepareLocalAction!(remote.envelope),
    );
    expect(value).toBeUndefined();
    expect(report.work['driver/command.candidateFallback.not-exact-published-base']).toBe(1);
    expect(p.document.publication.status().publication).toBe(held);
    p.receive(peer.document.store.encodeUpdate());
    expect(p.nodes().map((n) => n.content)).toEqual(['ab', 'cdef', 'tLail']);
    oracle.check(p.document, genesis);
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

for (const complete of [false, true])
  test(`structural preparation declines a cancelled ${complete ? 'complete' : 'partial'} native branch`, () => {
    const genesis = commandGenesis('abcdef'),
      p = commandReplica(genesis, undefined, 'materialized'),
      peer = commandReplica(genesis),
      oracle = createMaterializationOracle();
    try {
      const first = peer.editor
        .session('remote')
        .edit(insertText, { nodeId: peer.handle(peer.nodes()[0]), from: 1, text: 'Q' });
      peer.editor
        .session('remote')
        .edit(
          insertText,
          { nodeId: peer.handle(peer.nodes()[0]), from: 2, text: 'R' },
          { typing: false },
        );
      if (
        first.status !== 'applied' ||
        !(p.document.publication instanceof MaterializedPublication)
      )
        throw new Error('Expected materialized');
      const publication = p.document.publication,
        before = publication.diagnostics().nativeBodiesIntegrated;
      p.document.store.applyUpdate(peer.document.store.encodeUpdate());
      let work = publication.refresh(0);
      while (
        publication.diagnostics().nativeBodiesIntegrated < before + (complete ? 2 : 1) &&
        work.state === 'deferred'
      )
        work = work.continuation.resume(1);
      expect(work.state).toBe('deferred');
      if (work.state === 'deferred') work.continuation.cancel();
      p.document.store.append({
        ...first.envelope,
        groupId: { ...first.envelope.groupId, sequence: 999n },
      });
      p.editor.refresh();
      const { value, report } = captureDiagnostics(() =>
        p.editor.session('local').edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
      );
      expect(value.status).toBe('applied');
      expect(report.work['author/command.candidateFallback.incomplete-native-base']).toBe(1);
      expect(p.nodes().map((n) => n.content)).toEqual(['ab', 'cdef']);
      oracle.check(p.document, genesis);
    } finally {
      oracle.destroy();
      peer.close();
      p.close();
    }
  });

test('competing private preparation invalidates the older handle without an append', () => {
  const p = commandReplica(commandGenesis('abcdef'), undefined, 'materialized');
  try {
    if (!('prepareLocalAction' in p.document)) throw new Error('Expected materialized');
    const document = p.document,
      prepare = document.prepareLocalAction.bind(document);
    vi.spyOn(document, 'prepareLocalAction').mockImplementation((action) => {
      const first = prepare(action)!;
      expect(prepare(action)).toBeUndefined();
      return first;
    });
    expect(() =>
      p.editor.session().edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
    ).toThrow('no longer current');
    expect(document.store.snapshot().ready).toHaveLength(0);
    vi.restoreAllMocks();
    expect(p.editor.session().edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 }).status).toBe(
      'applied',
    );
    expect(document.store.snapshot().ready).toHaveLength(1);
  } finally {
    p.close();
  }
});
