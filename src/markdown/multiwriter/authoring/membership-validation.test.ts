import { afterEach, expect, test } from 'vitest';
import { parseBlocks } from '../../block-parser/api.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { openReferenceDocument } from '../reference/document.js';
import type { ActionEnvelope, InterpretationPacket, SemanticEffect } from '../contracts.js';
import { resourceKey } from '../layout/index.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function candidate() {
  const genesis = commandGenesis('abcdef\n\nforeign');
  const a = commandReplica(genesis);
  cleanup.push(() => a.close());
  const source = 'first\n\n# second',
    nodeId = a.handle(a.nodes()[0]);
  const result = a.editor.edit(
    { local: 'validation', group: 1n },
    insertText,
    { nodeId, from: 0, to: 6, text: source },
    { conversion: { nodeId, plan: parseBlocks(source, { provenance: true }).provenance } },
  );
  if (result.status !== 'applied') throw new Error();
  const ordinal = result.envelope.effects.findIndex((e) => e.type === 'Interpret');
  const interpret = result.envelope.effects[ordinal];
  if (interpret.type !== 'Interpret') throw new Error();
  return { genesis, action: result.envelope, packet: interpret.packet, ordinal };
}
function changePacket(
  action: ActionEnvelope,
  ordinal: number,
  change: Partial<InterpretationPacket>,
) {
  const effects = [...action.effects],
    effect = effects[ordinal];
  if (effect.type !== 'Interpret') throw new Error();
  effects[ordinal] = { ...effect, packet: { ...effect.packet, ...change } };
  return { ...action, effects };
}
function foreignContent(genesis: ReturnType<typeof commandGenesis>) {
  const doc = openReferenceDocument(genesis);
  try {
    doc.publication.refresh();
    const run = genesis.layout.allocations.filter((a) => a.type === 'run').at(-1)!;
    if (run.type !== 'run') throw new Error();
    const tape = run.skeleton[0].tape;
    const markers = doc.publication
      .status()
      .publication!.native.snapshot(tape)
      .parts.filter((p) => p.type === 'marker');
    return { tape, start: markers[1].marker, end: markers.at(-2)!.marker };
  } finally {
    doc.destroy();
  }
}
function rejected(genesis: ReturnType<typeof commandGenesis>, action: ActionEnvelope) {
  const doc = openReferenceDocument(genesis);
  cleanup.push(() => doc.destroy());
  expect(() => doc.certifyLocal(action)).toThrow(/certification/);
  doc.store.append(action);
  expect(doc.store.snapshot().ready).toEqual([]);
  expect(doc.store.snapshot().actions[0].readiness).toEqual({
    state: 'quarantined',
    reason: 'reference',
  });
}
test.each([
  'source-output',
  'foreign-output',
  'wrapper-output',
  'out-of-range',
  'pre-packet',
  'forbidden',
  'source-properties',
  'checked',
  'empty-properties',
  'foreign-range',
  'two-packets',
  'two-output-owners',
] as const)('rejects complete action with invalid membership: %s', (kind) => {
  const { genesis, action, packet, ordinal } = candidate();
  let bad = action;
  const member = packet.effectOrdinals![0],
    property = packet.effectOrdinals!.at(-1)!;
  switch (kind) {
    case 'source-output':
      bad = changePacket(action, ordinal, { derivedInlineOutputs: [packet.source] });
      break;
    case 'foreign-output':
      bad = changePacket(action, ordinal, {
        derivedInlineOutputs: [
          genesis.layout.allocations.find((a) => a.type === 'node' && a.role === 'inline')!
            .id as typeof packet.source,
        ],
      });
      break;
    case 'wrapper-output':
      bad = changePacket(action, ordinal, {
        derivedInlineOutputs: [
          genesis.layout.allocations.find((a) => a.type === 'node' && a.role === 'root')!
            .id as typeof packet.source,
        ],
      });
      break;
    case 'out-of-range':
      bad = changePacket(action, ordinal, { effectOrdinals: [action.effects.length] });
      break;
    case 'pre-packet':
      bad = changePacket(action, ordinal, { effectOrdinals: [ordinal - 1] });
      break;
    case 'forbidden': {
      const effects = [...action.effects];
      effects[member] = { type: 'InsertText', ranges: [] };
      bad = { ...action, effects };
      break;
    }
    case 'source-properties':
    case 'checked':
    case 'empty-properties': {
      const effects = [...action.effects],
        e = effects[property];
      if (e.type !== 'SetProperties') throw new Error();
      effects[property] =
        kind === 'source-properties'
          ? { ...e, node: packet.source }
          : { ...e, values: kind === 'checked' ? { checked: null } : {} };
      bad = { ...action, effects };
      break;
    }
    case 'foreign-range': {
      const effects = [...action.effects],
        transfer = effects[member];
      if (transfer.type !== 'TransferRange') throw new Error();
      const foreign = genesis.layout.allocations.filter((a) => a.type === 'run').at(-1)!;
      if (foreign.type !== 'run') throw new Error();
      // Change the retained run skeleton too: this is structurally consistent,
      // but the packet is not allowed to capture another source's cells.
      effects[member] = { ...transfer, ranges: [foreignContent(genesis)] };
      bad = {
        ...action,
        effects,
        allocations: action.allocations.map((a) =>
          a.type === 'run' && resourceKey(a.id) === resourceKey(transfer.run)
            ? { ...a, skeleton: [foreignContent(genesis)] }
            : a,
        ),
      };
      break;
    }
    case 'two-packets':
    case 'two-output-owners': {
      const id = {
        ...packet.id,
        ordinal: Math.max(...action.allocations.map((a) => a.id.ordinal)) + 1,
      };
      const later: SemanticEffect = {
        type: 'Interpret',
        packet: {
          ...packet,
          id,
          ...(kind === 'two-packets'
            ? { derivedInlineOutputs: undefined }
            : { effectOrdinals: undefined }),
        },
      };
      if (later.type !== 'Interpret') throw new Error();
      if (kind === 'two-packets')
        delete (later.packet as { derivedInlineOutputs?: unknown }).derivedInlineOutputs;
      else delete (later.packet as { effectOrdinals?: unknown }).effectOrdinals;
      bad = {
        ...action,
        allocations: [...action.allocations, { type: 'interpretation', id }],
        effects: [...action.effects, later],
      };
      break;
    }
  }
  rejected(genesis, bad);
});
test('superseding a packet does not hide an invalid member transfer', () => {
  const { genesis, action, packet } = candidate();
  const id = {
    ...packet.id,
    ordinal: Math.max(...action.allocations.map((a) => a.id.ordinal)) + 1,
  };
  const { derivedInlineOutputs: _outputs, effectOrdinals: _members, ...plain } = packet;
  const effects = [
    ...action.effects,
    { type: 'Interpret' as const, packet: { ...plain, id, syntaxMask: [], placements: [] } },
  ];
  const member = packet.effectOrdinals![0],
    transfer = effects[member];
  if (transfer.type !== 'TransferRange') throw new Error();
  const foreign = genesis.layout.allocations.filter((a) => a.type === 'run').at(-1)!;
  if (foreign.type !== 'run') throw new Error();
  effects[member] = { ...transfer, ranges: [foreignContent(genesis)] };
  const bad = {
    ...action,
    effects,
    allocations: [
      ...action.allocations.map((a) =>
        a.type === 'run' && resourceKey(a.id) === resourceKey(transfer.run)
          ? { ...a, skeleton: [foreignContent(genesis)] }
          : a,
      ),
      { type: 'interpretation' as const, id },
    ],
  };
  rejected(genesis, bad);
});

test('a member split retains constructor coverage when superseded, and hidden malformed bases reject', async () => {
  const { NativeFixture } = await import('../ownership/test-fixtures.js');
  const { reconstructProvenance } = await import('../reference/provenance.js');
  const f = new NativeFixture();
  cleanup.push(() => f.destroy());
  f.author('A1', (f) => {
    const id = f.allocate('firstPacket', 'interpretation');
    const split = f.split('P', 'N', 'P2');
    if (split.type !== 'SplitFlow') throw new Error();
    const packet = {
      id,
      source: f.id('P', 'node'),
      properties: { presentation: 'paragraph' as const, marker: null, info: null },
      wrappers: [],
      placements: [],
      syntaxMask: [],
      synthesizedText: [],
      derivedInlineOutputs: [split.newNode],
      effectOrdinals: [1],
    };
    return [
      { type: 'Interpret', packet },
      split,
      {
        type: 'Interpret',
        packet: {
          id: f.allocate('winner', 'interpretation'),
          source: packet.source,
          properties: { presentation: 'code', marker: null, info: null },
          wrappers: [],
          placements: [],
          syntaxMask: [],
          synthesizedText: [],
        },
      },
    ];
  });
  const envelope = f.envelope('A1');
  const action: ActionEnvelope = {
    ...envelope,
    allocations: [
      ...envelope.allocations,
      ...envelope.effects.flatMap((e) =>
        e.type === 'Interpret' ? [{ type: 'interpretation' as const, id: e.packet.id }] : [],
      ),
    ],
  };
  const genesis = {
    documentId: 'D',
    genesisId: 'G',
    layout: f.genesis,
    body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
  };
  const accepted = commandReplica(genesis);
  cleanup.push(() => accepted.close());
  accepted.document.certifyLocal(action);
  accepted.document.store.append(action);
  accepted.editor.refresh();
  expect(accepted.nodes().map((n) => n.content)).toEqual(['abcdef']);
  const provenance = reconstructProvenance(genesis.layout, [action]);
  expect(
    provenance.birthContent.find((n) => resourceKey(n.node) === resourceKey(f.id('N', 'node')))!
      .intervals,
  ).toHaveLength(2);
  const effects = [...action.effects],
    split = effects[1];
  if (split.type !== 'SplitFlow') throw new Error();
  const basis = split.basis.ranges[0];
  effects[1] = {
    ...split,
    basis: {
      ranges: [{ ...basis, occurrence: split.occurrence }],
    },
  };
  rejected(genesis, { ...action, effects });
});
