import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { seed, change } from '../../../../test/multiwriter/projection-consumer.js';
import type { Projection } from '../../../../test/multiwriter/projection-consumer.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import { deleteBackwardAtStart } from '../../../editing/commands/delete-backward.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { indent } from '../../../editing/commands/indent.js';
import { outdent } from '../../../editing/commands/outdent.js';
import { parseBlocks } from '../../block-parser/api.js';
import { isImmutableData } from '../../../../test/multiwriter/immutable.js';
import { captureDiagnostics } from '../diagnostics.js';
import type { DiagnosticReport } from '../diagnostics.js';
import { resolveAddress, textPoint } from '../projection/addresses.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import { commandViewIndex } from '../authoring/view-index.js';
import { OwnershipResult } from '../ownership/ownership.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import type { ReferenceGenesis } from '../reference/document.js';
import type { ViewNode } from '../projection/types.js';

function consume(
  p: CommandReplica,
  seeded: ReturnType<typeof seed>,
  before: Projection,
  unrelated?: ViewNode | readonly ViewNode[],
  inspect?: (report: DiagnosticReport) => void,
) {
  const input = change(p, before),
    bytes = p.document.store.encodeUpdate(),
    held = structuredClone(before.view);
  const homes = vi.spyOn(OwnershipResult.prototype, 'homeForFlow'),
    allHomes = vi.spyOn(OwnershipResult.prototype, 'homeBindings', 'get');
  let captured: ReturnType<
    typeof captureDiagnostics<ReturnType<typeof seeded.consumer.prepareStructural>>
  >;
  try {
    captured = captureDiagnostics(() => seeded.consumer.prepareStructural(input));
    expect(homes).not.toHaveBeenCalled();
    expect(allHomes).not.toHaveBeenCalled();
  } finally {
    homes.mockRestore();
    allHomes.mockRestore();
  }
  const { value: result, report } = captured;
  inspect?.(report);
  expect(result.state, result.state === 'fallback' ? result.reason : '').toBe('prepared');
  if (result.state !== 'prepared') throw new Error(result.reason);
  const cold = commandReplica(p.genesis, bytes, 'reference'),
    reference = cold.document.publication.status().publication!.value;
  // This fresh reference checkpoint is immutable. Preserve every full lookup
  // while avoiding a detached clone of its complete allocation array per address.
  // The proxy has no registered candidate index and binds all native/ownership
  // methods to the independent reference. Nothing is retained across checkpoints.
  const allocations = reference.ownership.nodeAllocations;
  const addressOwnership = new Proxy(reference.ownership, {
    get(target, property) {
      if (property === 'nodeAllocations') return allocations;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const production = p.document.publication.status().publication!.value;
    if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized document');
    expect(p.document.projectionDiagnostics().fullProjections).toBe(1);
    expect(production.view).toEqual(reference.view);
    expect(production.visibility).toEqual(reference.visibility);
    expect(production.interpretations.packets).toEqual(reference.interpretations.packets);
    expect(production.interpretations.masks).toEqual(reference.interpretations.masks);
    expect(production.ownership.assignments).toEqual(reference.ownership.assignments);
    expect(production.ownership.destinationRequirements).toEqual(
      reference.ownership.destinationRequirements,
    );
    expect(result.value.view).toEqual(reference.view);
    expect(isImmutableData(result.value.view, new WeakSet())).toBe(true);
    expect(result.value.visibility).toEqual(reference.visibility);
    const actualIndex = commandViewIndex(result.value.view.root),
      referenceIndex = commandViewIndex(reference.view.root);
    expect([...actualIndex.origins.keys()]).toEqual([...referenceIndex.origins.keys()]);
    for (const [handle, node] of referenceIndex.origins) {
      expect(actualIndex.origins.get(handle)).toEqual(node);
      expect(actualIndex.parents.get(handle)).toEqual(referenceIndex.parents.get(handle));
      expect(actualIndex.siblings.get(handle)).toEqual(referenceIndex.siblings.get(handle));
      expect(actualIndex.handleOrigin(node.origin.representative)).toBe(handle);
    }
    expect(result.value.interpretations.packets).toEqual(reference.interpretations.packets);
    expect(result.value.interpretations.masks).toEqual(reference.interpretations.masks);
    for (const node of reference.ownership.nodeAllocations) {
      expect(result.value.interpretations.properties(node.id)).toEqual(
        reference.interpretations.properties(node.id),
      );
      expect(production.interpretations.properties(node.id)).toEqual(
        reference.interpretations.properties(node.id),
      );
    }
    const check = (node: ViewNode) => {
      for (const boundary of node.boundaries) {
        const expected = resolveAddress(boundary.address, addressOwnership, reference.visibility);
        expect(
          resolveAddress(boundary.address, result.value.ownership, result.value.visibility),
        ).toEqual(expected);
        expect(
          resolveAddress(boundary.address, production.ownership, production.visibility),
        ).toEqual(expected);
      }
      for (const child of node.children) check(child);
    };
    check(result.value.view.root);
    check(before.view.root);
    for (const name of [
      'projection.fullProjectors',
      'projection.fullIndexesConstructed',
      'projection.normalizationIndexesConstructed',
      'command.fullIndexesConstructed',
      'witness.fullIndexesConstructed',
      'interpretation.fullIndexesConstructed',
      'subtree.fullIndexesConstructed',
      'projection.visibilityNodesExported',
      'projection.visibilityTapesExported',
      'interpretation.sourcesExported',
    ])
      expect(report.work[`driver/${name}`] ?? 0, name).toBe(0);
    for (const retained of unrelated ? (Array.isArray(unrelated) ? unrelated : [unrelated]) : []) {
      expect(report.resources['projection.regionRawNodes'] ?? []).not.toContain(
        resourceKey(retained.origin.representative),
      );
      expect(report.resources['projection.normalizationBoundaryNodes'] ?? []).not.toContain(
        resourceKey(retained.origin.representative),
      );
      const find = (node: ViewNode): ViewNode | undefined =>
        node.origin.representative.ordinal === retained.origin.representative.ordinal &&
        resourceKey(node.origin.representative) === resourceKey(retained.origin.representative)
          ? node
          : node.children.map(find).find(Boolean);
      expect(find(result.value.view.root)).toBe(retained);
    }
    result.commit();
    expect(before.view).toEqual(held);
    expect(compareBytes(bytes, p.document.store.encodeUpdate())).toBe(0);
    return result.value;
  } finally {
    cold.close();
  }
}

for (const markdown of [
  '3. abcdef\n4. second\n\nother\n\ntail',
  '> abcdef\n>\n> second\n\nother\n\ntail',
  'intro\n\n# abcdef\n\nchild\n\n## second\n\nbody',
])
  describe(`one-pass region: ${markdown.split('\n')[0]}`, () => {
    let p: CommandReplica,
      seeded: ReturnType<typeof seed>,
      value: Projection,
      history: ReturnType<CommandReplica['editor']['session']>,
      tail: ViewNode;
    beforeAll(() => {
      p = commandReplica(commandGenesis(markdown), undefined, 'materialized');
      seeded = seed(p);
      value = seeded.value;
      history = p.editor.session('region');
      tail = seeded.value.view.root.children.at(-1)!;
    });
    afterAll(() => p.close());
    const next = () => {
      value = consume(p, seeded, value, markdown.startsWith('intro') ? undefined : tail);
    };
    const ordinal = markdown.startsWith('intro') ? 1 : 0;
    test('split', () => {
      expect(
        history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[ordinal]), from: 3 }).status,
      ).toBe('applied');
      next();
    });
    test('type in split side', () => {
      expect(
        history.edit(
          insertText,
          { nodeId: p.handle(p.nodes()[ordinal + 1]), from: 0, text: '!' },
          { typing: false },
        ).status,
      ).toBe('applied');
      next();
    });
    test('join', () => {
      expect(
        history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[ordinal + 1]) }).status,
      ).toBe('applied');
      next();
    });
    test('undo join', () => {
      expect(history.undo().state).toBe('applied');
      next();
    });
    test('redo join', () => {
      expect(history.redo().state).toBe('applied');
      next();
    });
  });

for (const markdown of [
  '> left\n\nseparator\n\n> right\n\nother\n\ntail',
  '> left\n\n- middle\n\n> right\n\nother\n\ntail',
  '7. first\n8. middle\n9. last\n\nother\n\ntail',
])
  test(`deletion, cleanup and wrapper boundaries retain one-pass order: ${markdown.split('\n')[0]}`, () => {
    const p = commandReplica(commandGenesis(markdown), undefined, 'materialized'),
      seeded = seed(p),
      history = p.editor.session('cleanup'),
      tail = seeded.value.view.root.children.at(-1)!;
    let value = seeded.value;
    try {
      expect(history.edit(deleteBlocks, { nodeIds: [p.handle(p.nodes()[1])] }).status).toBe(
        'applied',
      );
      value = consume(p, seeded, value, tail);
      expect(history.undo().state).toBe('applied');
      value = consume(p, seeded, value, tail);
      expect(history.redo().state).toBe('applied');
      value = consume(p, seeded, value, tail);
      expect(
        history.edit(insertText, { nodeId: p.handle(p.nodes()[0]), from: 1, text: '!' }).status,
      ).toBe('applied');
      consume(p, seeded, value, tail);
    } finally {
      p.close();
    }
  });

for (const operation of ['indent', 'outdent', 'paste', 'heading-backspace', 'interpret'] as const)
  test(`managed ${operation} feeds complete regional comparisons and history`, () => {
    const markdown =
      operation === 'outdent'
        ? '- first\n  - abcdef\n- third\n\ntail'
        : operation === 'heading-backspace'
          ? 'intro\n\n# abcdef\n\nchild\n\ntail'
          : operation === 'indent'
            ? '- first\n- abcdef\n- third\n\ntail'
            : 'abcdef\n\nother\n\ntail';
    const p = commandReplica(commandGenesis(markdown), undefined, 'materialized'),
      seeded = seed(p),
      history = p.editor.session(operation);
    let value = seeded.value;
    try {
      const nodeId = p.handle(
        p.nodes()[
          operation === 'indent' || operation === 'outdent' || operation === 'heading-backspace'
            ? 1
            : 0
        ],
      );
      const result =
        operation === 'indent'
          ? history.edit(indent, { nodeId })
          : operation === 'outdent'
            ? history.edit(outdent, { nodeId })
            : operation === 'paste'
              ? history.edit(insertMarkdown, { contextId: nodeId, markdown: '> pasted\n\n- item' })
              : operation === 'heading-backspace'
                ? history.edit(deleteBackwardAtStart, { nodeId })
                : history.edit(insertText, { nodeId, from: 0, text: '# ' }, { promote: nodeId });
      expect(result.status).toBe('applied');
      value = consume(p, seeded, value);
      expect(history.undo().state).toBe('applied');
      value = consume(p, seeded, value);
      expect(history.redo().state).toBe('applied');
      consume(p, seeded, value);
    } finally {
      p.close();
    }
  });

test('multiple packet outputs, winner replacement and exact masks keep their native origins', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized'),
    seeded = seed(p),
    history = p.editor.session('interpret');
  let value = seeded.value;
  try {
    const source = 'first\n\n# second',
      nodeId = p.handle(p.nodes()[0]);
    expect(
      history.edit(
        insertText,
        { nodeId, from: 0, to: 6, text: source },
        { conversion: { nodeId, plan: parseBlocks(source, { provenance: true }).provenance } },
      ).status,
    ).toBe('applied');
    value = consume(p, seeded, value);
    expect(history.undo().state).toBe('applied');
    value = consume(p, seeded, value);
    expect(history.redo().state).toBe('applied');
    value = consume(p, seeded, value);
    const selected = textPoint(p.nodes()[1], 1, 'left');
    expect(resolveAddress(selected.address, value.ownership, value.visibility).state).toBe(
      'available',
    );
  } finally {
    p.close();
  }
});

for (const size of [10, 150])
  for (const difficult of ['plain', 'deleted'] as const)
    describe(`bounded list region among ${size} unrelated paragraphs (${difficult})`, () => {
      let p: CommandReplica,
        seeded: ReturnType<typeof seed>,
        value: Projection,
        history: ReturnType<CommandReplica['editor']['session']>,
        tail: ViewNode;
      beforeAll(() => {
        p = commandReplica(
          commandGenesis(
            '3. abcdef\n4. second\n\n' +
              Array.from({ length: size }, (_, i) => `p${i}abcdef`).join('\n\n'),
          ),
          undefined,
          'materialized',
        );
        if (difficult === 'deleted')
          expect(
            p.editor.edit({ local: 'distant', group: 1n }, deleteBlocks, {
              nodeIds: [p.handle(p.nodes().at(-2)!)],
            }).status,
          ).toBe('applied');
        seeded = seed(p);
        value = seeded.value;
        history = p.editor.session('list-scale');
        tail = value.view.root.children.at(-1)!;
      });
      afterAll(() => p.close());
      const next = () => {
        value = consume(p, seeded, value, tail);
      };
      test('split', () => {
        expect(
          history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 3 }).status,
        ).toBe('applied');
        next();
      });
      test('join', () => {
        expect(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }).status).toBe(
          'applied',
        );
        next();
      });
      test('undo', () => {
        expect(history.undo().state).toBe('applied');
        next();
      });
      test('redo', () => {
        expect(history.redo().state).toBe('applied');
        next();
      });
    });

test('competing interpretation packets retain losing births and eligibility through owner controls', () => {
  const genesis = commandGenesis('abcdef\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis);
  try {
    const id = p.handle(p.nodes()[0]);
    const first = p.editor.edit(
      { local: 'heading', group: 1n },
      insertText,
      { nodeId: id, from: 0, text: '# ' },
      { promote: id },
    );
    expect(first.status).toBe('applied');
    const seeded = seed(p);
    let value = seeded.value;
    const peerId = peer.handle(peer.nodes()[0]);
    const second = peer.editor.edit(
      { local: 'quote', group: 1n },
      insertText,
      { nodeId: peerId, from: 0, text: '> ' },
      { promote: peerId },
    );
    expect(second.status).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    value = consume(p, seeded, value);
    const off = control(p, first, false);
    value = consume(p, seeded, value);
    control(p, first, true, off);
    value = consume(p, seeded, value);
    expect(
      value.visibility.nodes.some((n) => n.suppressed || n.scaffold) ||
        value.interpretations.packets.length === 1,
    ).toBe(true);
  } finally {
    peer.close();
    p.close();
  }
});

test('normalization preparation cancellation preserves held roots and canonical bytes', () => {
  const p = commandReplica(
    commandGenesis('4. abcdef\n5. second\n\ntail'),
    undefined,
    'materialized',
  );
  try {
    const seeded = seed(p),
      held = structuredClone(seeded.value.view),
      bytes = p.document.store.encodeUpdate();
    expect(
      p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }).status,
    ).toBe('applied');
    const input = change(p, seeded.value),
      canonical = p.document.store.encodeUpdate(),
      first = seeded.consumer.prepareStructural(input);
    expect(first.state).toBe('prepared');
    seeded.consumer.cancel();
    if (first.state === 'prepared') expect(() => first.commit()).toThrow('no longer current');
    const second = seeded.consumer.prepareStructural(input);
    expect(second.state).toBe('prepared');
    if (second.state === 'prepared') second.commit();
    expect(compareBytes(canonical, p.document.store.encodeUpdate())).toBe(0);
    expect(compareBytes(bytes, canonical)).not.toBe(0);
    expect(seeded.value.view).toEqual(held);
  } finally {
    p.close();
  }
});

test('an earlier concurrent deletion retracts existing split visibility and recovers on control', () => {
  const genesis = commandGenesis('abcdef\n\nother\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis);
  try {
    expect(
      p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }).status,
    ).toBe('applied');
    expect(
      p.editor.edit({ local: 'later', group: 1n }, insertText, {
        nodeId: p.handle(p.nodes()[1]),
        from: 1,
        text: '!',
      }).status,
    ).toBe('applied');
    const seeded = seed(p);
    let value = seeded.value;
    const history = peer.editor.session('earlier-delete');
    expect(history.edit(deleteBlocks, { nodeIds: [peer.handle(peer.nodes()[0])] }).status).toBe(
      'applied',
    );
    const bytes = peer.document.store.encodeUpdate();
    p.receive(bytes);
    const input = change(p, value);
    expect(input.action.lamport).toBeLessThan(input.actions.at(-1)!.lamport);
    value = consume(p, seeded, value);
    p.receive(bytes);
    expect(seeded.consumer.prepareStructural(change(p, value))).toMatchObject({
      state: 'fallback',
      reason: 'missing-exact-addition',
    });
    peer.receive(p.document.store.encodeUpdate());
    expect(history.undo().state).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    value = consume(p, seeded, value);
    expect(history.redo().state).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    consume(p, seeded, value);
  } finally {
    peer.close();
    p.close();
  }
});

for (const schedule of ['split-type', 'split-undo', 'paste-undo-redo'] as const)
  test(`one exact ready-source batch preserves every birth and control: ${schedule}`, () => {
    const genesis = commandGenesis('abcdef\n\nother\n\ntail'),
      p = commandReplica(genesis, undefined, 'materialized'),
      peer = commandReplica(genesis);
    try {
      const seeded = seed(p),
        history = peer.editor.session('batch');
      if (schedule.startsWith('split')) {
        expect(
          history.edit(insertParagraph, { nodeId: peer.handle(peer.nodes()[0]), from: 3 }).status,
        ).toBe('applied');
        if (schedule === 'split-type')
          expect(
            history.edit(
              insertText,
              { nodeId: peer.handle(peer.nodes()[1]), from: 1, text: '!' },
              { typing: false },
            ).status,
          ).toBe('applied');
        else expect(history.undo().state).toBe('applied');
      } else {
        expect(
          history.edit(insertMarkdown, {
            contextId: peer.handle(peer.nodes()[0]),
            markdown: '> pasted\n\n- item',
          }).status,
        ).toBe('applied');
        expect(history.undo().state).toBe('applied');
        expect(history.redo().state).toBe('applied');
      }
      p.receive(peer.document.store.encodeUpdate());
      consume(p, seeded, seeded.value);
    } finally {
      peer.close();
      p.close();
    }
  });

test('transfers retain ghost addresses through source deletion and subsequent edits', () => {
  const p = commandReplica(
      commandGenesis('abcdef\n\nxyz\n\nmiddle\n\ntail'),
      undefined,
      'materialized',
    ),
    seeded = seed(p),
    history = p.editor.session('transfer'),
    tail = seeded.value.view.root.children.at(-1)!;
  let value = seeded.value;
  try {
    expect(
      history.edit(
        (ctx, args: { source: string; destination: string }) => {
          ctx.draft.transferInlineRange({ ...args, from: 1, to: 3, at: 1, affinity: 'right' });
          return { status: 'handled' };
        },
        { source: p.handle(p.nodes()[0]), destination: p.handle(p.nodes()[1]) },
      ).status,
    ).toBe('applied');
    value = consume(p, seeded, value, tail);
    expect(history.edit(deleteBlocks, { nodeIds: [p.handle(p.nodes()[0])] }).status).toBe(
      'applied',
    );
    value = consume(p, seeded, value, tail);
    expect(
      history.edit(
        insertText,
        { nodeId: p.handle(p.nodes()[0]), from: 2, text: '!' },
        { typing: false },
      ).status,
    ).toBe('applied');
    value = consume(p, seeded, value, tail);
    expect(history.undo().state).toBe('applied');
    value = consume(p, seeded, value, tail);
    expect(history.redo().state).toBe('applied');
    consume(p, seeded, value, tail);
  } finally {
    p.close();
  }
});

test('all-content deletion, empty slots and continued typing preserve history and held publications', () => {
  const p = commandReplica(commandGenesis('first\n\nsecond'), undefined, 'materialized'),
    seeded = seed(p),
    history = p.editor.session('all-content');
  let value = seeded.value;
  try {
    expect(
      history.edit(deleteBlocks, { nodeIds: p.nodes().map((node) => p.handle(node)) }).status,
    ).toBe('applied');
    value = consume(p, seeded, value);
    expect(history.undo().state).toBe('applied');
    value = consume(p, seeded, value);
    expect(history.redo().state).toBe('applied');
    value = consume(p, seeded, value);
    expect(
      history.edit(insertText, { nodeId: p.handle(p.nodes()[0]), from: 0, text: 'new' }).status,
    ).toBe('applied');
    consume(p, seeded, value);
  } finally {
    p.close();
  }
});

for (const deleted of [false, true])
  describe(`mixed nonempty wrappers retain independent regions (deleted=${deleted})`, () => {
    let p: CommandReplica,
      seeded: ReturnType<typeof seed>,
      value: Projection,
      history: ReturnType<CommandReplica['editor']['session']>,
      unrelated: readonly ViewNode[];
    beforeAll(() => {
      p = commandReplica(
        commandGenesis(
          '3. abcdef\n4. next\n\n> unrelated\n>\n> quote body\n\n- later\n\ntail\n\ndistant',
        ),
        undefined,
        'materialized',
      );
      if (deleted)
        expect(
          p.editor.edit({ local: 'distant-delete', group: 1n }, deleteBlocks, {
            nodeIds: [p.handle(p.nodes().at(-1)!)],
          }).status,
        ).toBe('applied');
      seeded = seed(p);
      value = seeded.value;
      unrelated = value.view.root.children.slice(1, 3);
      history = p.editor.session('mixed');
    });
    afterAll(() => p.close());
    const next = () => {
      value = consume(p, seeded, value, unrelated);
    };
    test('split', () => {
      expect(
        history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 3 }).status,
      ).toBe('applied');
      next();
    });
    test('join', () => {
      expect(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }).status).toBe(
        'applied',
      );
      next();
    });
    test('unrelated text edit', () => {
      const tail = p.nodes().find((n) => n.content === 'tail')!;
      expect(
        p.editor.edit({ local: 'tail', group: 1n }, insertText, {
          nodeId: p.handle(tail),
          from: 1,
          text: '!',
        }).status,
      ).toBe('applied');
      next();
    });
    test('undo join', () => {
      expect(history.undo().state).toBe('applied');
      next();
    });
    test('redo join', () => {
      expect(history.redo().state).toBe('applied');
      next();
    });
  });

/** Raw available empty wrappers are intentional pre-cleanup barriers. Ordinary
 * Markdown parsing removes some of them before genesis, so construct their
 * original native/genesis identities explicitly for these boundary controls. */
function boundaryFixture(
  barrier: 'empty' | 'invisible',
  tail: 'empty' | 'nonempty',
  kind: 'quote' | 'list' = 'quote',
) {
  const inline = (id: string, parent: string, text: string) => ({
    id,
    parent,
    role: 'inline' as const,
    flow: `f${id}`,
    run: `r${id}`,
    tape: `t${id}`,
    cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
  });
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'left', parent: 'root', role: kind },
    ...(kind === 'list' ? [{ id: 'itemP', parent: 'left', role: 'list-item' as const }] : []),
    inline('P', kind === 'list' ? 'itemP' : 'left', 'abcdef'),
    { id: 'barrier', parent: 'root', role: kind === 'quote' ? 'list' : 'quote' },
    { id: 'right', parent: 'root', role: kind },
    ...(tail === 'nonempty'
      ? [
          ...(kind === 'list'
            ? [{ id: 'itemQ', parent: 'right', role: 'list-item' as const }]
            : []),
          inline('Q', kind === 'list' ? 'itemQ' : 'right', 'right'),
        ]
      : []),
    inline('T', 'root', 'tail'),
  ]);
  const genesis: ReferenceGenesis = {
    documentId: 'D',
    genesisId: 'G',
    layout: f.genesis,
    body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    initialProperties:
      kind === 'list'
        ? [
            { node: f.id('itemP', 'node'), values: { marker: '3. ' } },
            ...(tail === 'nonempty'
              ? [{ node: f.id('itemQ', 'node'), values: { marker: '9. ' } }]
              : []),
          ]
        : [],
  };
  const p = commandReplica(genesis, undefined, 'materialized');
  if (barrier === 'invisible') {
    f.author('A1', (f) => [f.deleteSubtree('barrier', [], [])]);
    p.document.certifyLocal(f.envelope('A1'));
    p.document.store.append(f.envelope('A1'));
    p.editor.refresh();
  }
  return { f, p };
}

for (const kind of ['quote', 'list'] as const)
  for (const barrier of ['empty', 'invisible'] as const)
    for (const right of ['empty', 'nonempty'] as const)
      test(`one-pass ${kind} boundary preserves ${barrier} gaps and ${right} cleanup origins`, () => {
        const { f, p } = boundaryFixture(barrier, right, kind);
        try {
          const seeded = seed(p),
            history = p.editor.session('boundary');
          let value = seeded.value;
          const oldOrigins = structuredClone(value.view.root.children[0].origin);
          expect(
            history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 3 }).status,
          ).toBe('applied');
          value = consume(p, seeded, value);
          if (barrier === 'empty' && right === 'empty') {
            expect(value.view.root.children[0].origin.constituents).toEqual([f.id('left', 'node')]);
            expect(value.view.root.children[1].origin.constituents).toEqual([
              f.id('right', 'node'),
            ]);
          } else expect(value.view.root.children[0].origin).toEqual(oldOrigins);
          expect(history.undo().state).toBe('applied');
          value = consume(p, seeded, value);
          expect(value.view.root.children[0].origin).toEqual(oldOrigins);
          expect(history.redo().state).toBe('applied');
          consume(p, seeded, value);
        } finally {
          p.close();
          f.destroy();
        }
      });

test('a former cleanup gap invalidates origin contributors when it becomes nonempty', () => {
  const { f, p } = boundaryFixture('empty', 'empty');
  try {
    const seeded = seed(p);
    expect(seeded.value.view.root.children[0].origin.constituents).toContainEqual(
      f.id('right', 'node'),
    );
    // Install real content in the retained, previously cleaned list barrier.
    f.author('A1', (f) => {
      f.createBlock({ id: 'item', parent: 'barrier', role: 'list-item' }, null);
      f.createBlock(
        {
          id: 'B',
          parent: 'item',
          role: 'inline',
          flow: 'fB',
          run: 'rB',
          tape: 'tB',
          cells: [{ id: 'B0', text: '!' }],
        },
        null,
      );
      return [];
    });
    p.document.certifyLocal(f.envelope('A1'));
    p.document.store.append(f.envelope('A1'));
    p.editor.refresh();
    const value = consume(p, seeded, seeded.value);
    expect(value.view.root.children[0].origin.constituents).not.toContainEqual(
      f.id('right', 'node'),
    );
  } finally {
    p.close();
    f.destroy();
  }
});

for (const size of [8, 32, 128])
  describe(`neighboring quote growth leaves list region work fixed (${size})`, () => {
    let p: CommandReplica, seeded: ReturnType<typeof seed>, unrelated: readonly ViewNode[];
    beforeAll(() => {
      p = commandReplica(
        commandGenesis(
          '3. abcdef\n4. next\n\n' +
            Array.from({ length: size }, () => '> q').join('\n>\n') +
            '\n\n- later\n\ntail',
        ),
        undefined,
        'materialized',
      );
      seeded = seed(p);
      unrelated = seeded.value.view.root.children.slice(1, 3);
      expect(
        p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
          nodeId: p.handle(p.nodes()[0]),
          from: 3,
        }).status,
      ).toBe('applied');
    });
    afterAll(() => p.close());
    test('preserves complete independent output, addresses and untouched records with charged work', () => {
      consume(p, seeded, seeded.value, unrelated, (report) => {
        expect(report.work['driver/projection.regionRawNodesBuilt']).toBe(7);
        expect(report.work['driver/projection.normalizationBoundaryNodesInspected']).toBe(7);
        expect(report.work['driver/projection.regionRootEntriesInspected']).toBe(8);
      });
    });
  });

for (const count of [1, 2])
  test(`moving ${count} root barriers retains the merge at their former gap`, () => {
    const p = commandReplica(
      commandGenesis(
        '> left\n\n' +
          Array.from({ length: count }, (_, i) => `separator${i}`).join('\n\n') +
          '\n\n> right\n\ntail',
      ),
      undefined,
      'materialized',
    );
    try {
      const seeded = seed(p),
        separators = p.view().root.children.filter((node) => node.content.startsWith('separator')),
        history = p.editor.session('root-barrier-move');
      let value = seeded.value;
      expect(
        history.edit(
          (ctx, args) => {
            for (const node of args.nodes) ctx.draft.place(node, args.root, null);
            return { status: 'handled' };
          },
          { nodes: separators.map(p.handle), root: p.handle(p.view().root) },
        ).status,
      ).toBe('applied');
      value = consume(p, seeded, value);
      expect(value.view.root.children[0].origin.constituents).toHaveLength(2);
      expect(history.undo().state).toBe('applied');
      value = consume(p, seeded, value);
      expect(history.redo().state).toBe('applied');
      consume(p, seeded, value);
    } finally {
      p.close();
    }
  });
