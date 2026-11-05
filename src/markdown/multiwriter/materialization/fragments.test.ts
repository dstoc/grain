import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { NativeTapeIndex } from './native-tape.js';
import { OwnershipResult } from '../ownership/ownership.js';

test('text projection retains unchanged visible and hidden fragments without rereading native substrings', () => {
  const genesis = commandGenesis('abc😀def\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    for (let i = 0; i < 40; i++)
      expect(
        p.editor.edit({ local: 'replace', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[0]),
          from: 1,
          to: 2,
          text: i % 2 ? 'Y' : 'X',
        }).status,
      ).toBe('applied');
    const held = p.nodes()[0],
      visible = held.fragments.find((fragment) => fragment.text === 'a' && fragment.visible),
      hidden = held.fragments.find((fragment) => fragment.text === 'b' && !fragment.visible);
    expect(visible).toBeDefined();
    expect(hidden).toBeDefined();
    peer.receive(p.document.store.encodeUpdate());
    expect(
      peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
        nodeId: peer.handle(peer.nodes()[0]),
        from: 1,
        to: 2,
        text: 'Z',
      }).status,
    ).toBe('applied');
    const reads = vi.spyOn(NativeTapeIndex.prototype, 'lookup');
    try {
      p.receive(peer.document.store.encodeUpdate());
      expect(reads.mock.calls.length).toBeLessThan(5);
    } finally {
      reads.mockRestore();
    }
    expect(
      p.nodes()[0].fragments.find((fragment) => fragment.text === 'a' && fragment.visible),
    ).toBe(visible);
    expect(
      p.nodes()[0].fragments.find((fragment) => fragment.text === 'b' && !fragment.visible),
    ).toBe(hidden);
    expect(held.content).toBe('aYc😀def');
    expect(p.nodes()[0].content).toBe('aZc😀def');
    oracle.check(p.document, genesis);
    const cold = commandReplica(genesis, p.document.store.encodeUpdate());
    try {
      expect(cold.observe()).toEqual(p.observe());
    } finally {
      cold.close();
    }
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('local projection reads permanent ending markers without exporting retained tape snapshots', () => {
  const genesis = commandGenesis('abc😀def\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    for (let i = 0; i < 40; i++)
      expect(
        p.editor.edit({ local: 'replace', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[0]),
          from: 1,
          to: 2,
          text: i % 2 ? 'Y' : 'X',
        }).status,
      ).toBe('applied');
    peer.receive(p.document.store.encodeUpdate());
    expect(
      peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
        nodeId: peer.handle(peer.nodes()[0]),
        from: 1,
        to: 2,
        text: 'Z',
      }).status,
    ).toBe('applied');
    const held = p.document.publication.status().publication!,
      snapshots = vi.spyOn(NativeTapeIndex.prototype, 'snapshot'),
      runs = vi.spyOn(OwnershipResult.prototype, 'runLayout');
    try {
      p.receive(peer.document.store.encodeUpdate());
      expect(snapshots).not.toHaveBeenCalled();
      expect(runs).toHaveBeenCalledTimes(1);
    } finally {
      snapshots.mockRestore();
      runs.mockRestore();
    }
    expect(held.value.view.root.children[0].content).toBe('aYc😀def');
    expect(p.nodes()[0].content).toBe('aZc😀def');
    oracle.check(p.document, genesis);
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});
