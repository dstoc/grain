import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import { resolveAddress, textPoint } from '../projection/addresses.js';
import * as full from '../projection/project.js';
import { captureDiagnostics } from '../diagnostics.js';

import { seed, change } from '../../../../test/multiwriter/projection-consumer.js';
import type { Projection } from '../../../../test/multiwriter/projection-consumer.js';

function applied<T extends { status: string }>(result: T): T {
  expect(result.status).toBe('applied');
  return result;
}

function controlledFixture(
  size: number,
  difficult: 'plain' | 'deleted' | 'suppressed' | 'scaffold',
) {
  let p: CommandReplica;
  p = commandReplica(
    commandGenesis(Array.from({ length: size }, (_, i) => `p${i}abcdef`).join('\n\n')),
    undefined,
    'materialized',
  );
  if (difficult === 'deleted')
    applied(
      p.editor.edit({ local: 'delete', group: 1n }, deleteBlocks, {
        nodeIds: [p.handle(p.nodes()[8])],
      }),
    );
  if (difficult === 'suppressed' || difficult === 'scaffold') {
    const split = p.editor.edit({ local: 'setup', group: 1n }, insertParagraph, {
      nodeId: p.handle(p.nodes()[8]),
      from: difficult === 'scaffold' ? p.nodes()[8].content.length : 3,
    });
    if (split.status !== 'applied') throw new Error('Expected split');
    if (difficult === 'scaffold')
      applied(
        p.editor.edit({ local: 'peer-content', group: 1n }, insertText, {
          nodeId: p.handle(p.nodes()[9]),
          from: 0,
          text: 'peer',
        }),
      );
    control(p, split, false);
    expect(
      p.document.publication.status().publication!.value.visibility.nodes.some((n) => n[difficult]),
    ).toBe(true);
  }
  const seeded = seed(p),
    consumer = seeded.consumer;
  let value = seeded.value;
  const held = value,
    heldView = structuredClone(held.view),
    tail = held.view.root.children.at(-1)!;
  const saved = textPoint(tail, 2, 'right').address;
  const addresses = [saved];
  const history = p.editor.session('controlled');
  const consume = () => {
    for (const node of value.view.root.children.slice(0, 2))
      if (node.type === 'paragraph') {
        addresses.push(
          textPoint(node, 0, 'left').address,
          textPoint(node, node.content.length, 'right').address,
        );
      }
    const input = change(p, value),
      bytes = p.document.store.encodeUpdate();
    const projector = vi.spyOn(full, 'projectWithActivity');
    try {
      const { value: candidate, report } = captureDiagnostics(() =>
        consumer.prepareStructural(input),
      );
      expect(candidate.state, candidate.state === 'fallback' ? candidate.reason : '').toBe(
        'prepared',
      );
      if (candidate.state !== 'prepared') throw new Error(candidate.reason);
      expect(projector).not.toHaveBeenCalled();
      expect(report.work['driver/projection.fullProjectors'] ?? 0).toBe(0);
      expect(report.work['driver/projection.fullIndexesConstructed'] ?? 0).toBe(0);
      expect(report.work['driver/deletion.fullIndexesConstructed'] ?? 0).toBe(0);
      expect(report.work['driver/command.fullIndexesConstructed'] ?? 0).toBe(0);
      expect(report.work['driver/projection.visibilityNodesExported'] ?? 0).toBe(0);
      expect(report.work['driver/projection.visibilityTapesExported'] ?? 0).toBe(0);
      expect(report.resources['projection.rawFlowRecords'] ?? []).not.toContain(
        resourceKey(tail.origin.representative),
      );
      expect(report.work['driver/projection.rawFlowRecordsBuilt']).toBeLessThanOrEqual(2);
      const cold = commandReplica(p.genesis, bytes, 'reference');
      try {
        expect(candidate.value.view).toEqual(cold.view());
        expect(candidate.value.visibility).toEqual(
          cold.document.publication.status().publication!.value.visibility,
        );
        expect(candidate.value.ownership.assignments).toEqual(
          cold.document.publication.status().publication!.value.ownership.assignments,
        );
        const reference = cold.document.publication.status().publication!.value;
        for (const address of addresses)
          expect(
            resolveAddress(address, candidate.value.ownership, candidate.value.visibility),
          ).toEqual(resolveAddress(address, reference.ownership, reference.visibility));
      } finally {
        cold.close();
      }
      expect(candidate.value.view.root.children.at(-1)).toBe(tail);
      expect(resolveAddress(saved, candidate.value.ownership, candidate.value.visibility)).toEqual(
        resolveAddress(saved, p.document.publication.status().publication!.value.ownership, {
          ...p.document.publication.status().publication!.value.visibility,
        }),
      );
      candidate.commit();
      value = candidate.value;
      expect(compareBytes(bytes, p.document.store.encodeUpdate())).toBe(0);
      expect(held.view).toEqual(heldView);
    } finally {
      projector.mockRestore();
    }
  };
  return { p, history, consume };
}
for (const size of [10, 150])
  for (const difficult of ['plain', 'deleted', 'suppressed', 'scaffold'] as const)
    describe(`controlled C uninterrupted trace ${size}/${difficult}`, { concurrent: false }, () => {
      let fixture: ReturnType<typeof controlledFixture>;
      beforeAll(() => {
        fixture = controlledFixture(size, difficult);
      });
      afterAll(() => {
        fixture?.p.close();
      });
      test('split', () => {
        const { p, history, consume } = fixture;
        applied(history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 3 }));
        consume();
      });
      test('type in the left flow', () => {
        const { p, history, consume } = fixture;
        applied(
          history.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[0]), from: 1, text: 'L' },
            { typing: false },
          ),
        );
        consume();
      });
      test('type in the right flow', () => {
        const { p, history, consume } = fixture;
        applied(
          history.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[1]), from: 1, text: 'R' },
            { typing: false },
          ),
        );
        consume();
      });
      test('join', () => {
        const { p, history, consume } = fixture;
        applied(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }));
        consume();
      });
      test('unrelated text edit', () => {
        const { p, consume } = fixture;
        applied(
          p.editor.edit({ local: 'unrelated', group: 1n }, insertText, {
            nodeId: p.handle(p.nodes()[4]),
            from: 1,
            text: 'U',
          }),
        );
        consume();
      });
      test('undo join', () => {
        expect(fixture.history.undo().state).toBe('applied');
        fixture.consume();
      });
      test('redo join', () => {
        expect(fixture.history.redo().state).toBe('applied');
        fixture.consume();
      });
    });

test('controlled candidates cancel atomically and decline incomplete lineage without changing held publications', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  try {
    const { consumer, value } = seed(p),
      held = structuredClone(value.view);
    applied(
      p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }),
    );
    const input = change(p, value),
      commit = vi.fn();
    const prepared = consumer.prepareStructural({
      ...input,
      structure: { ...input.structure, commit },
    });
    expect(prepared.state).toBe('prepared');
    if (prepared.state !== 'prepared') throw new Error(prepared.reason);
    consumer.cancel();
    expect(() => prepared.commit()).toThrow('no longer current');
    expect(commit).not.toHaveBeenCalled();
    expect(value.view).toEqual(held);
    const incomplete = consumer.prepareStructural({ ...input, rootRuns: new Map() });
    expect(incomplete).toMatchObject({ state: 'fallback', reason: 'missing-root-run' });
    expect(value.view).toEqual(held);
    const retry = consumer.prepareStructural(input);
    expect(retry.state).toBe('prepared');
    if (retry.state !== 'prepared') throw new Error(retry.reason);
    retry.commit();
    expect(() => retry.commit()).toThrow('no longer current');
    expect(consumer.prepareStructural(input)).toMatchObject({
      state: 'fallback',
      reason: 'incompatible-base',
    });
    consumer.evict();
    expect(retry.value.view).toEqual(p.view());
    expect(value.view).toEqual(held);
  } finally {
    p.close();
  }
});

test('an unchanged one-pass wrapper boundary is not normalized a second time', () => {
  const p = commandReplica(
    commandGenesis('> a\n\n- x\n\n> b\n\nplain\n\ntail'),
    undefined,
    'materialized',
  );
  try {
    applied(
      p.editor.edit({ local: 'delete', group: 1n }, deleteBlocks, {
        nodeIds: [p.handle(p.nodes()[1])],
      }),
    );
    const { consumer, value } = seed(p);
    expect(value.view.root.children.slice(0, 2).map((n) => n.type)).toEqual([
      'block-quote',
      'block-quote',
    ]);
    const held = value.view.root.children.slice(0, 2);
    applied(
      p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[2]),
        from: 2,
      }),
    );
    const result = consumer.prepareStructural(change(p, value));
    expect(result.state, result.state === 'fallback' ? result.reason : '').toBe('prepared');
    if (result.state !== 'prepared') throw new Error(result.reason);
    expect(result.value.view).toEqual(p.view());
    expect(result.value.view.root.children[0]).toBe(held[0]);
    expect(result.value.view.root.children[1]).toBe(held[1]);
  } finally {
    p.close();
  }
});

for (const markdown of ['- abcdef\n\ntail', '# abcdef\n\ntail'])
  test(`nested or heading-dependent split uses shared normalization: ${markdown}`, () => {
    const p = commandReplica(commandGenesis(markdown), undefined, 'materialized');
    try {
      const { consumer, value } = seed(p);
      applied(
        p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
          nodeId: p.handle(p.nodes()[0]),
          from: 3,
        }),
      );
      const result = consumer.prepareStructural(change(p, value));
      expect(result.state, result.state === 'fallback' ? result.reason : '').toBe('prepared');
      if (result.state !== 'prepared') throw new Error(result.reason);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference');
      try {
        expect(result.value.view).toEqual(cold.view());
        expect(result.value.visibility).toEqual(
          cold.document.publication.status().publication!.value.visibility,
        );
      } finally {
        cold.close();
      }
    } finally {
      p.close();
    }
  });

for (const source of ['quote', 'section-child', 'merged-quote'] as const)
  test(`controlled paragraph split/join retains enclosing wrapper context: ${source}`, () => {
    const markdown =
      source === 'section-child'
        ? '# heading\n\nabcdef\n\ntail'
        : source === 'merged-quote'
          ? '> abcdef\n\nseparator\n\n> ghijkl\n\ntail'
          : '> abcdef\n\ntail';
    const p = commandReplica(commandGenesis(markdown), undefined, 'materialized');
    try {
      if (source === 'merged-quote')
        applied(
          p.editor.edit({ local: 'delete', group: 1n }, deleteBlocks, {
            nodeIds: [p.handle(p.nodes()[1])],
          }),
        );
      const seeded = seed(p);
      let value = seeded.value;
      const ordinal = source === 'section-child' || source === 'merged-quote' ? 1 : 0;
      const history = p.editor.session('nested');
      const consume = () => {
        const result = seeded.consumer.prepareStructural(change(p, value));
        expect(result.state, result.state === 'fallback' ? result.reason : '').toBe('prepared');
        if (result.state !== 'prepared') throw new Error(result.reason);
        expect(result.value.view).toEqual(p.view());
        expect(result.value.visibility).toEqual(
          p.document.publication.status().publication!.value.visibility,
        );
        result.commit();
        value = result.value;
      };
      applied(history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[ordinal]), from: 3 }));
      consume();
      applied(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[ordinal + 1]) }));
      consume();
      expect(history.undo().state).toBe('applied');
      consume();
      expect(history.redo().state).toBe('applied');
      consume();
    } finally {
      p.close();
    }
  });

test('captured joined-source addresses remain available after creation undo and redo', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  try {
    const creation = p.editor.edit({ local: 'create', group: 1n }, insertParagraph, {
      nodeId: p.handle(p.nodes()[0]),
      from: 6,
    });
    if (creation.status !== 'applied') throw new Error('Expected creation');
    applied(
      p.editor.edit({ local: 'peer-text', group: 1n }, insertText, {
        nodeId: p.handle(p.nodes()[1]),
        from: 0,
        text: 'peer',
      }),
    );
    const address = textPoint(p.nodes()[1], 1, 'right').address;
    const seeded = seed(p);
    let value = seeded.value;
    const consume = () => {
      const candidate = seeded.consumer.prepareStructural(change(p, value));
      expect(candidate.state, candidate.state === 'fallback' ? candidate.reason : '').toBe(
        'prepared',
      );
      if (candidate.state !== 'prepared') throw new Error(candidate.reason);
      const reference = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference');
      try {
        const full = reference.document.publication.status().publication!.value;
        expect(candidate.value.view).toEqual(full.view);
        expect(candidate.value.visibility).toEqual(full.visibility);
        expect(
          resolveAddress(address, candidate.value.ownership, candidate.value.visibility),
        ).toEqual(resolveAddress(address, full.ownership, full.visibility));
        expect(
          resolveAddress(address, candidate.value.ownership, candidate.value.visibility).state,
        ).toBe('available');
      } finally {
        reference.close();
      }
      candidate.commit();
      value = candidate.value;
    };
    applied(
      p.editor.edit({ local: 'join', group: 1n }, joinWithPrevious, {
        nodeId: p.handle(p.nodes()[1]),
      }),
    );
    consume();
    const undo = control(p, creation, false);
    consume();
    expect(value.visibility.nodes.some((n) => n.suppressed)).toBe(true);
    control(p, creation, true, undo);
    consume();
  } finally {
    p.close();
  }
});

test('joining paragraphs within one list item preserves wrapper gaps and numbering without a new item', () => {
  const p = commandReplica(
    commandGenesis('- abcdef\n\n  ghijkl\n\ntail'),
    undefined,
    'materialized',
  );
  try {
    const seeded = seed(p);
    let value = seeded.value;
    const history = p.editor.session('same-item');
    const consume = () => {
      const candidate = seeded.consumer.prepareStructural(change(p, value));
      expect(candidate.state, candidate.state === 'fallback' ? candidate.reason : '').toBe(
        'prepared',
      );
      if (candidate.state !== 'prepared') throw new Error(candidate.reason);
      expect(candidate.value.view).toEqual(p.view());
      expect(candidate.value.visibility).toEqual(
        p.document.publication.status().publication!.value.visibility,
      );
      candidate.commit();
      value = candidate.value;
    };
    applied(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }));
    consume();
    expect(history.undo().state).toBe('applied');
    consume();
    expect(history.redo().state).toBe('applied');
    consume();
  } finally {
    p.close();
  }
});

test('captured sibling intervals on a participating split tape remain resource-local', () => {
  const p = commandReplica(commandGenesis('abcdef\n\nother\n\ntail'), undefined, 'materialized');
  try {
    applied(
      p.editor.edit({ local: 'setup', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }),
    );
    applied(
      p.editor.edit({ local: 'delete', group: 1n }, deleteBlocks, {
        nodeIds: [p.handle(p.nodes()[1])],
      }),
    );
    const seeded = seed(p),
      tail = seeded.value.view.root.children.at(-1)!;
    let value = seeded.value;
    const consume = () => {
      const input = change(p, value),
        bytes = p.document.store.encodeUpdate();
      const { value: result, report } = captureDiagnostics(() =>
        seeded.consumer.prepareStructural(input),
      );
      expect(result.state, result.state === 'fallback' ? result.reason : '').toBe('prepared');
      if (result.state !== 'prepared') throw new Error(result.reason);
      const cold = commandReplica(p.genesis, bytes, 'reference');
      try {
        expect(result.value.view).toEqual(cold.view());
        expect(result.value.visibility).toEqual(
          cold.document.publication.status().publication!.value.visibility,
        );
        expect(result.value.view.root.children.at(-1)).toBe(tail);
        expect(report.work['driver/subtree.fullIndexesConstructed'] ?? 0).toBe(0);
        expect(report.work['driver/projection.fullProjectors'] ?? 0).toBe(0);
        expect(compareBytes(bytes, p.document.store.encodeUpdate())).toBe(0);
        result.commit();
        value = result.value;
      } finally {
        cold.close();
      }
    };
    const history = p.editor.session('covered-split');
    applied(history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 1 }));
    consume();
    applied(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }));
    consume();
    expect(history.undo().state).toBe('applied');
    consume();
    expect(history.redo().state).toBe('applied');
    consume();
  } finally {
    p.close();
  }
});

for (const size of [10, 150])
  describe(`controlled deletion witnesses (${size})`, () => {
    let p: CommandReplica,
      seeded: ReturnType<typeof seed>,
      value: Projection,
      tail: Projection['view']['root']['children'][number];
    let history: ReturnType<CommandReplica['editor']['session']>;
    beforeAll(() => {
      p = commandReplica(
        commandGenesis(Array.from({ length: size }, (_, i) => `p${i}abcdef`).join('\n\n')),
        undefined,
        'materialized',
      );
      seeded = seed(p);
      value = seeded.value;
      tail = value.view.root.children.at(-1)!;
      history = p.editor.session('deletion-witness');
    });
    afterAll(() => p.close());
    const consume = () => {
      const input = change(p, value),
        bytes = p.document.store.encodeUpdate(),
        held = value.view;
      const { value: result, report } = captureDiagnostics(() =>
        seeded.consumer.prepareStructural(input),
      );
      expect(result.state, result.state === 'fallback' ? result.reason : '').toBe('prepared');
      if (result.state !== 'prepared') throw new Error(result.reason);
      const cold = commandReplica(p.genesis, bytes, 'reference');
      try {
        expect(result.value.view).toEqual(cold.view());
        expect(result.value.visibility).toEqual(
          cold.document.publication.status().publication!.value.visibility,
        );
        expect(result.value.view.root.children.at(-1)).toBe(tail);
        expect(report.work['driver/projection.fullProjectors'] ?? 0).toBe(0);
        expect(report.work['driver/witness.fullIndexesConstructed'] ?? 0).toBe(0);
        expect(report.work['driver/subtree.fullIndexesConstructed'] ?? 0).toBe(0);
        expect(report.resources['witness.records'] ?? []).not.toContain(
          resourceKey(tail.origin.representative),
        );
        result.commit();
        value = result.value;
        expect(compareBytes(bytes, p.document.store.encodeUpdate())).toBe(0);
        expect(held.root.children.at(-1)).toBe(tail);
      } finally {
        cold.close();
      }
    };
    test('delete one paragraph', () => {
      applied(history.edit(deleteBlocks, { nodeIds: [p.handle(p.nodes()[0])] }));
      consume();
    });
    test('undo deletion', () => {
      expect(history.undo().state).toBe('applied');
      consume();
    });
    test('redo deletion', () => {
      expect(history.redo().state).toBe('applied');
      consume();
    });
    test('edit after deletion', () => {
      applied(history.edit(insertText, { nodeId: p.handle(p.nodes()[0]), from: 1, text: '!' }));
      consume();
    });
  });

test('concurrent subtree deletion updates weak split birth and destination witnesses without changing distant records', () => {
  const genesis = commandGenesis('abcdef\n\nother\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis);
  try {
    applied(
      p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }),
    );
    applied(
      peer.editor.edit({ local: 'prior', group: 1n }, insertText, {
        nodeId: peer.handle(peer.nodes()[1]),
        from: 1,
        text: '!',
      }),
    );
    p.receive(peer.document.store.encodeUpdate());
    const seeded = seed(p),
      held = seeded.value,
      tail = held.view.root.children.at(-1)!,
      saved = textPoint(held.view.root.children[1], 1, 'right').address;
    let value = held;
    const consume = () => {
      const input = change(p, value),
        bytes = p.document.store.encodeUpdate();
      const { value: result, report } = captureDiagnostics(() =>
        seeded.consumer.prepareStructural(input),
      );
      expect(result.state, result.state === 'fallback' ? result.reason : '').toBe('prepared');
      if (result.state !== 'prepared') throw new Error(result.reason);
      const cold = commandReplica(genesis, bytes, 'reference');
      try {
        expect(result.value.view).toEqual(cold.view());
        expect(result.value.visibility).toEqual(
          cold.document.publication.status().publication!.value.visibility,
        );
        expect(resolveAddress(saved, result.value.ownership, result.value.visibility)).toEqual(
          resolveAddress(
            saved,
            cold.document.publication.status().publication!.value.ownership,
            cold.document.publication.status().publication!.value.visibility,
          ),
        );
        expect(result.value.view.root.children.at(-1)).toBe(tail);
        expect(report.work['driver/projection.fullProjectors'] ?? 0).toBe(0);
        expect(report.work['driver/splitVisibility.fullIndexesConstructed'] ?? 0).toBe(0);
        result.commit();
        value = result.value;
      } finally {
        cold.close();
      }
    };
    const deletion = peer.editor.session('delete');
    applied(deletion.edit(deleteBlocks, { nodeIds: [peer.handle(peer.nodes()[0])] }));
    p.receive(peer.document.store.encodeUpdate());
    consume();
    expect(value.visibility.nodes.some((n) => n.suppressed && !n.deleted)).toBe(true);
    peer.receive(p.document.store.encodeUpdate());
    expect(deletion.undo().state).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    consume();
    expect(deletion.redo().state).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    consume();
    expect(held.view.root.children[1].content).toBe('def');
  } finally {
    peer.close();
    p.close();
  }
});
