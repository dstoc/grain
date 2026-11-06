import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import { captureDiagnostics } from '../diagnostics.js';
import { compareBytes } from '../actions/cbor.js';
import { textPoint, resolveAddress } from '../projection/addresses.js';
import { resourceKey } from '../layout/index.js';
import { seed, change } from '../../../../test/multiwriter/projection-consumer.js';

function fixture(size: number, difficult: 'plain' | 'deleted' | 'suppressed' | 'scaffold') {
  const p = commandReplica(
    commandGenesis(Array.from({ length: size }, (_, i) => `p${i}abcdef`).join('\n\n')),
    undefined,
    'materialized',
  );
  if (difficult === 'deleted')
    expect(
      p.editor.edit({ local: 'setup', group: 1n }, deleteBlocks, {
        nodeIds: [p.handle(p.nodes()[8])],
      }).status,
    ).toBe('applied');
  if (difficult === 'suppressed' || difficult === 'scaffold') {
    const split = p.editor.edit({ local: 'setup', group: 1n }, insertParagraph, {
      nodeId: p.handle(p.nodes()[8]),
      from: difficult === 'scaffold' ? p.nodes()[8].content.length : 3,
    });
    if (split.status !== 'applied') throw new Error('Expected setup split');
    if (difficult === 'scaffold')
      expect(
        p.editor.edit({ local: 'peer', group: 1n }, insertText, {
          nodeId: p.handle(p.nodes()[9]),
          from: 0,
          text: 'peer',
        }).status,
      ).toBe('applied');
    control(p, split, false);
  }
  if (difficult !== 'plain')
    expect(
      p.document.publication
        .status()
        .publication!.value.visibility.nodes.some((node) => node[difficult]),
    ).toBe(true);
  if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized document');
  const document = p.document;
  const history = p.editor.session('trace');
  const held = document.publication.status().publication!;
  const heldView = structuredClone(held.value.view),
    heldVisibility = structuredClone(held.value.visibility),
    heldNative = held.native.encodeState(),
    tail = p.nodes().at(-1)!;
  const addresses = [textPoint(tail, 2, 'left').address, textPoint(tail, 2, 'right').address];
  const step = (
    operation: () => { readonly status?: string; readonly state?: string },
    control = false,
  ) => {
    for (const node of p.nodes().slice(0, 2))
      for (const affinity of ['left', 'right'] as const)
        addresses.push(
          textPoint(node, 0, affinity).address,
          textPoint(node, node.content.length, affinity).address,
        );
    const before = document.projectionDiagnostics();
    const { value: result, report } = captureDiagnostics(operation);
    expect(result.status ?? result.state).toBe('applied');
    const after = document.projectionDiagnostics();
    expect(after.fullProjections).toBe(before.fullProjections);
    for (const name of [
      'provenance.fullReconstructions',
      'provenance.actionsMaterialized',
      'projection.fullProjectors',
      'projection.fullIndexesConstructed',
      'command.fullIndexesConstructed',
      'deletion.fullIndexesConstructed',
      'coupled.readyAuditEntries',
    ])
      expect(report.work[`publication/${name}`] ?? 0, name).toBe(0);
    expect(report.work['publication/coupled.candidatesCommitted']).toBe(1);
    if (control) {
      // Activity changes invalidate the exact historical suffix. With fewer
      // than 128 actions B has no periodic checkpoint before that frontier.
      expect(after.ownership.lastReplayReason).toBe('changed-order-or-activity');
      expect(after.ownership.lastReplayFrom).toBe(0);
    } else expect(after.ownership.coldReplays).toBe(before.ownership.coldReplays);
    expect(report.resources['publication/projection.rawFlowRecords'] ?? []).not.toContain(
      resourceKey(tail.origin.representative),
    );
    expect(p.nodes().at(-1)).toBe(tail);
    const bytes = document.store.encodeUpdate(),
      current = document.publication.status().publication!;
    const cold = commandReplica(p.genesis, bytes, 'reference');
    try {
      const reference = cold.document.publication.status().publication!.value;
      expect(current.value.view).toEqual(reference.view);
      expect(current.value.visibility).toEqual(reference.visibility);
      expect(current.value.ownership.assignments).toEqual(reference.ownership.assignments);
      expect(current.value.ownership.destinationRequirements).toEqual(
        reference.ownership.destinationRequirements,
      );
      for (const address of addresses)
        expect(resolveAddress(address, current.value.ownership, current.value.visibility)).toEqual(
          resolveAddress(address, reference.ownership, reference.visibility),
        );
      expect(
        compareBytes(
          current.native.encodeState(),
          cold.document.publication.status().publication!.native.encodeState(),
        ),
      ).toBe(0);
    } finally {
      cold.close();
    }
    expect(compareBytes(bytes, document.store.encodeUpdate())).toBe(0);
    expect(held.value.view).toEqual(heldView);
    expect(held.value.visibility).toEqual(heldVisibility);
    expect(compareBytes(held.native.encodeState(), heldNative)).toBe(0);
    expect(resolveAddress(addresses[0], held.value.ownership, held.value.visibility).state).toBe(
      'available',
    );
  };
  return { p, history, step };
}
for (const size of [10, 150])
  for (const difficult of ['plain', 'deleted', 'suppressed', 'scaffold'] as const)
    describe(`production trace ${size}/${difficult}`, () => {
      let f: ReturnType<typeof fixture>;
      beforeAll(() => {
        f = fixture(size, difficult);
      });
      afterAll(() => {
        f?.p.close();
      });
      test('split', () =>
        f.step(() =>
          f.history.edit(insertParagraph, { nodeId: f.p.handle(f.p.nodes()[0]), from: 3 }),
        ));
      test('type left', () =>
        f.step(() =>
          f.history.edit(
            insertText,
            { nodeId: f.p.handle(f.p.nodes()[0]), from: 1, text: 'L' },
            { typing: false },
          ),
        ));
      test('type right', () =>
        f.step(() =>
          f.history.edit(
            insertText,
            { nodeId: f.p.handle(f.p.nodes()[1]), from: 1, text: 'R' },
            { typing: false },
          ),
        ));
      test('join', () =>
        f.step(() => f.history.edit(joinWithPrevious, { nodeId: f.p.handle(f.p.nodes()[1]) })));
      test('distant text', () =>
        f.step(() =>
          f.p.editor.edit({ local: 'distant', group: 1n }, insertText, {
            nodeId: f.p.handle(f.p.nodes()[4]),
            from: 1,
            text: 'U',
          }),
        ));
      test('undo join', () => f.step(() => f.history.undo(), true));
      test('redo join', () => f.step(() => f.history.redo(), true));
    });

for (const content of ['', 'abc'])
  test(`ordinary created paragraph birth activity remains separate from raw placement (${JSON.stringify(content)})`, () => {
    const p = commandReplica(commandGenesis('first\n\ntail'), undefined, 'materialized');
    if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized document');
    const document = p.document,
      history = p.editor.session('birth'),
      tail = p.nodes().at(-1)!,
      full = document.projectionDiagnostics().fullProjections;
    const check = () => {
      const current = document.publication.status().publication!.value,
        cold = commandReplica(p.genesis, document.store.encodeUpdate(), 'reference');
      try {
        const expected = cold.document.publication.status().publication!.value;
        expect(current.view).toEqual(expected.view);
        expect(current.visibility).toEqual(expected.visibility);
        expect(current.ownership.assignments).toEqual(expected.ownership.assignments);
        expect(document.projectionDiagnostics().fullProjections).toBe(full);
        expect(p.nodes().at(-1)).toBe(tail);
      } finally {
        cold.close();
      }
    };
    try {
      expect(
        history.edit((ctx) => {
          const node = ctx.draft.create({ type: 'paragraph', content });
          ctx.draft.place(node, ctx.scopeRoot, p.handle(p.nodes()[0]));
          return { status: 'handled' };
        }, undefined).status,
      ).toBe('applied');
      const held = document.publication.status().publication!.value,
        heldView = structuredClone(held.view),
        address = textPoint(p.nodes()[0], 0, 'right').address;
      check();
      expect(history.undo().state).toBe('applied');
      check();
      const hidden = document.publication.status().publication!.value;
      expect(resolveAddress(address, hidden.ownership, hidden.visibility).state).toBe(
        'unavailable',
      );
      expect(history.redo().state).toBe('applied');
      check();
      expect(held.view).toEqual(heldView);
      expect(resolveAddress(address, held.ownership, held.visibility).state).toBe('available');
    } finally {
      p.close();
    }
  });

test('concurrent inherited deletion accepts changed children before their parent', () => {
  const genesis = commandGenesis('> parent\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis);
  try {
    const parent = p.handle(p.view().root.children[0]);
    expect(
      p.editor.session('birth').edit((ctx) => {
        const child = ctx.draft.create({ type: 'paragraph', content: 'child' });
        ctx.draft.place(child, parent, null);
        return { status: 'handled' };
      }, undefined).status,
    ).toBe('applied');
    const seeded = seed(p),
      child = p.nodes().find((node) => node.content === 'child')!.origin.representative;
    expect(
      peer.editor.session('delete').edit((ctx) => {
        ctx.draft.deleteSubtree(peer.handle(peer.view().root.children[0]));
        return { status: 'handled' };
      }, undefined).status,
    ).toBe('applied');
    const { report } = captureDiagnostics(() => p.receive(peer.document.store.encodeUpdate()));
    expect(report.work['publication/provenance.fullReconstructions'] ?? 0).toBe(0);
    const input = change(p, seeded.value),
      candidate = seeded.consumer.prepareStructural({
        ...input,
        nodes: [child, ...input.nodes.filter((n) => resourceKey(n) !== resourceKey(child))],
      });
    expect(candidate.state, candidate.state === 'fallback' ? candidate.reason : '').toBe(
      'prepared',
    );
    if (candidate.state !== 'prepared') throw new Error(candidate.reason);
    const cold = commandReplica(genesis, p.document.store.encodeUpdate(), 'reference');
    try {
      const expected = cold.document.publication.status().publication!.value;
      expect(candidate.value.view).toEqual(expected.view);
      expect(candidate.value.visibility).toEqual(expected.visibility);
      expect(p.view()).toEqual(expected.view);
      expect(p.document.publication.status().publication!.value.visibility).toEqual(
        expected.visibility,
      );
      expect(
        expected.visibility.nodes.find((n) => resourceKey(n.node) === resourceKey(child))!.deleted,
      ).toBe(true);
    } finally {
      cold.close();
    }
  } finally {
    peer.close();
    p.close();
  }
});
