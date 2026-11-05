import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { ConstructionTreeDraft } from '../../semantic/construction-tree.js';
import * as projector from '../projection/project.js';
import { NativeTapeCache } from '../text/cache.js';
import { compareBytes } from '../actions/cbor.js';
import { RetainedEditError } from '../authoring/editor.js';

const open = (markdown: string) =>
  commandReplica(commandGenesis(markdown), undefined, 'materialized');
function diagnostics(p: CommandReplica) {
  if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized reader');
  return p.document.projectionDiagnostics();
}
function replace(
  p: CommandReplica,
  from: number,
  to: number,
  text: string,
  group = 1n,
  node = p.nodes()[0],
) {
  const result = p.editor.edit({ local: 'replace', group }, insertText, {
    nodeId: p.handle(node),
    from,
    to,
    text,
  });
  if (result.status !== 'applied') throw new Error('Expected applied text change');
  return result;
}
function coldEqual(p: CommandReplica) {
  const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'materialized');
  try {
    expect(cold.observe()).toEqual(p.observe());
  } finally {
    cold.close();
  }
}

for (const size of [10, 150])
  test(`exact deletion and replacement update one flow among ${size} paragraphs`, () => {
    const p = open(Array.from({ length: size }, () => 'abc😀def').join('\n\n')),
      oracle = createMaterializationOracle();
    try {
      const before = p.document.publication.status().publication!;
      const native = before.native.encodeState();
      const counts = diagnostics(p);
      const full = vi.spyOn(projector, 'projectWithActivity');
      const adopt = vi.spyOn(ConstructionTreeDraft.prototype, 'adopt');
      const snapshots = vi.spyOn(NativeTapeCache.prototype, 'snapshotSteps');
      try {
        replace(p, 1, 5, '');
        expect(p.nodes()[0].content).toBe('adef');
        expect(full).not.toHaveBeenCalled();
        expect(adopt).not.toHaveBeenCalled();
        expect(snapshots).not.toHaveBeenCalled();
        expect(
          compareBytes(p.document.publication.status().publication!.native.encodeState(), native),
        ).toBe(0);
        expect(diagnostics(p).projectionRecordsReplaced - counts.projectionRecordsReplaced).toBe(2);
        replace(p, 1, 3, '😀!', 2n);
        expect(p.nodes()[0].content).toBe('a😀!f');
        replace(p, 1, 1, 'x', 3n);
        expect(p.nodes()[0].content).toBe('ax😀!f');
        expect(full).not.toHaveBeenCalled();
        expect(adopt).not.toHaveBeenCalled();
      } finally {
        full.mockRestore();
        adopt.mockRestore();
        snapshots.mockRestore();
      }
      expect(p.document.publication.status().publication!.value.view.root.children[1]).toBe(
        before.value.view.root.children[1],
      );
      expect(before.value.view.root.children[0].content).toBe('abc😀def');
      expect(compareBytes(before.native.encodeState(), native)).toBe(0);
      oracle.check(p.document, p.genesis);
      coldEqual(p);
    } finally {
      oracle.destroy();
      p.close();
    }
  }, 60000);

test('exact deletion follows current transferred ownership and joined flows without changing other addresses', () => {
  const p = open('abcdef\n\nxyz\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    const transfer = p.editor.edit(
      { local: 'transfer', group: 1n },
      (ctx, args) => {
        ctx.draft.transferInlineRange({ ...args, from: 1, to: 3, at: 1, affinity: 'right' });
        return { status: 'handled' };
      },
      { source: p.handle(p.nodes()[0]), destination: p.handle(p.nodes()[1]) },
    );
    expect(transfer.status).toBe('applied');
    const source = p.nodes()[0],
      tail = p.nodes()[2];
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      replace(p, 1, 3, '', 1n, p.nodes()[1]);
      expect(p.nodes().map((n) => n.content)).toEqual(['adef', 'xyz', 'tail']);
      expect(p.nodes()[0]).toBe(source);
      expect(p.nodes()[2]).toBe(tail);
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    oracle.check(p.document, p.genesis);
    expect(
      p.editor.edit({ local: 'join', group: 1n }, joinWithPrevious, {
        nodeId: p.handle(p.nodes()[1]),
      }).status,
    ).toBe('applied');
    const afterJoin = vi.spyOn(projector, 'projectWithActivity');
    try {
      replace(p, 2, 6, '!', 2n);
      expect(p.nodes().map((n) => n.content)).toEqual(['ad!z', 'tail']);
      expect(afterJoin).not.toHaveBeenCalled();
    } finally {
      afterJoin.mockRestore();
    }
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('overlapping exact peer tags retain semantic order through undo, redo and later input', () => {
  const p = open('abcdef\n\ntail'),
    peer = commandReplica(p.genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    const local = replace(p, 1, 4, '');
    replace(peer, 2, 5, '', 1n);
    p.receive(peer.document.store.encodeUpdate());
    expect(p.nodes()[0].content).toBe('af');
    oracle.check(p.document, p.genesis);
    const undo = control(p, local, false);
    expect(p.nodes()[0].content).toBe('abf');
    oracle.check(p.document, p.genesis);
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      replace(p, 1, 1, '😀', 2n);
      expect(p.nodes()[0].content).toBe('a😀bf');
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    control(p, local, true, undo);
    expect(p.nodes()[0].content).toBe('a😀f');
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('text deletion preserves syntax masks and empty inline structure', () => {
  const p = open('abcdef\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    const nodeId = p.handle(p.nodes()[0]);
    expect(
      p.editor.edit(
        { local: 'promotion', group: 1n },
        insertText,
        { nodeId, from: 0, text: '# ' },
        { promote: nodeId },
      ).status,
    ).toBe('applied');
    expect(p.nodes()[0].type).toBe('section');
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      replace(p, 0, 6, '');
      expect(p.nodes()[0].type).toBe('section');
      expect(p.nodes()[0].content).toBe('');
      replace(p, 0, 0, '😀', 2n);
      expect(p.nodes()[0].content).toBe('😀');
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('managed replacement stages exact selection before a reentrant peer prepend and retains observer recovery', () => {
  const p = open('abcdef'),
    peer = commandReplica(p.genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  const history = p.editor.session('replacement'),
    nodeId = p.handle(p.nodes()[0]);
  let injected = false;
  const off = p.document.store.onUpdate((bytes) => {
    if (injected) return;
    injected = true;
    peer.receive(bytes);
    replace(peer, 0, 0, 'P');
    p.document.store.applyUpdate(peer.document.store.encodeUpdate());
  });
  try {
    const full = vi.spyOn(projector, 'projectMarkdown');
    try {
      expect(
        history.edit(
          insertText,
          { nodeId, from: 1, to: 4, text: '😀' },
          {
            selectionBefore: {
              anchor: { nodeId, offset: 1, affinity: 'right' },
              focus: { nodeId, offset: 4, affinity: 'right' },
            },
          },
        ).status,
      ).toBe('applied');
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
      off();
    }
    expect(p.nodes()[0].content).toBe('Pa😀ef');
    oracle.check(p.document, p.genesis);
    const undo = history.undo();
    expect(undo.state).toBe('applied');
    if (undo.state === 'applied')
      expect(undo.restoration).toMatchObject({
        state: 'exact',
        anchor: { offset: 2 },
        focus: { offset: 5 },
      });
    expect(p.nodes()[0].content).toBe('Pabcdef');
    expect(history.redo().state).toBe('applied');
    expect(p.nodes()[0].content).toBe('Pa😀ef');
    const fail = p.document.store.onUpdate(() => {
      throw new Error('observer');
    });
    try {
      expect(() => history.edit(insertText, { nodeId, from: 1, to: 4, text: '!' })).toThrow(
        RetainedEditError,
      );
    } finally {
      fail();
    }
    p.editor.refresh();
    oracle.check(p.document, p.genesis);
    expect(history.undo().state).toBe('applied');
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    off();
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('rejected replacement staging does not alter cache roots, canonical state or history', () => {
  const p = open('abcdef'),
    history = p.editor.session('rejected');
  try {
    const before = p.document.publication.status().publication!,
      bytes = p.document.store.encodeUpdate(),
      nodeId = p.handle(p.nodes()[0]);
    const reject = vi.spyOn(p.document, 'certifyLocal').mockImplementationOnce(() => {
      throw new Error('reject');
    });
    try {
      expect(() => history.edit(insertText, { nodeId, from: 1, to: 4, text: '!' })).toThrow(
        'reject',
      );
    } finally {
      reject.mockRestore();
    }
    expect(p.document.publication.status().publication).toBe(before);
    expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
    expect(history.status()).toMatchObject({ undo: 0, redo: 0 });
    expect(history.edit(insertText, { nodeId, from: 1, to: 4, text: '!' }).status).toBe('applied');
    const oracle = createMaterializationOracle();
    try {
      oracle.check(p.document, p.genesis);
    } finally {
      oracle.destroy();
    }
  } finally {
    p.close();
  }
});

test('fast text certification rejects a half-surrogate deletion before changing canonical state', () => {
  const p = open('a😀b'),
    oracle = createMaterializationOracle();
  try {
    const peer = commandReplica(p.genesis, undefined, 'materialized');
    let deletion;
    try {
      deletion = replace(peer, 1, 3, '');
    } finally {
      peer.close();
    }
    const before = p.document.publication.status().publication!,
      bytes = p.document.store.encodeUpdate();
    const bad = {
      ...deletion.envelope,
      effects: deletion.envelope.effects.map((effect) =>
        effect.type === 'DeleteText'
          ? { ...effect, observed: effect.observed.map((range) => ({ ...range, length: 1 })) }
          : effect,
      ),
    };
    expect(() => p.document.certifyLocal(bad)).toThrow(/native-body/);
    expect(p.document.publication.status().publication).toBe(before);
    expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
    replace(p, 1, 3, '!');
    expect(p.nodes()[0].content).toBe('a!b');
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});
