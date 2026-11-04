import { afterEach, expect, test } from 'vitest';
import { parseBlocks } from '../../block-parser/api.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import type { LocalEditResult } from './editor.js';
import { actorId } from '../contracts.js';
import type { ActionEnvelope, ActionId } from '../contracts.js';
import { compareBytes } from '../actions/cbor.js';

const close: (() => void)[] = [];
afterEach(() =>
  close
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function peers() {
  const genesis = commandGenesis(),
    a = commandReplica(genesis),
    b = commandReplica(genesis),
    c = commandReplica(genesis);
  close.push(
    () => a.close(),
    () => b.close(),
    () => c.close(),
  );
  return { genesis, a, b, c };
}
function convert(
  p: CommandReplica,
  source: string,
): Extract<LocalEditResult, { status: 'applied' }> {
  const nodeId = p.handle(p.nodes()[0]);
  const result = p.editor.edit(
    { local: 'parser', group: 1n },
    insertText,
    {
      nodeId,
      from: 0,
      to: p.nodes()[0].content.length,
      text: source,
    },
    { conversion: { nodeId, plan: parseBlocks(source, { provenance: true }).provenance } },
  );
  if (result.status !== 'applied') throw new Error(`Conversion ${result.status}`);
  return result;
}
function control(
  p: CommandReplica,
  result: Extract<LocalEditResult, { status: 'applied' }>,
  active: boolean,
  previous: ActionId | null = null,
) {
  const ready = p.document.store.snapshot().ready;
  const sequence =
    ready
      .filter((a) => a.id.actor === result.action.actor)
      .reduce((n, a) => (a.id.sequence > n ? a.id.sequence : n), 0n) + 1n;
  const action: ActionEnvelope = {
    protocolVersion: 3,
    documentId: 'D',
    genesisId: 'G',
    id: { ...result.action, sequence },
    lamport: ready.reduce((n, a) => (a.lamport > n ? a.lamport : n), 0n) + 1n,
    dependencies: p.document.publication.status().publication!.heads,
    groupId: { ...result.group, sequence: 100n + sequence },
    allocations: [],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects: [
      {
        type: 'SetGroupActive',
        group: result.group,
        actions: [result.action],
        active,
        previousControl: previous,
      },
    ],
  };
  p.document.certifyLocal(action);
  p.document.store.append(action);
  p.editor.refresh();
  return action.id;
}
test.each([
  'first\n\n# second',
  '- [x] repeated\n- [ ] repeated',
  '> first\n>\n> second',
  'first\n\n```js\ncode\n```',
])('parser outputs retract/reactivate and cold replay: %j', (source) => {
  const { genesis, a, b, c } = peers();
  const before = a.markdown(),
    result = convert(a, source),
    converted = a.markdown();
  expect(result.envelope.effects.find((e) => e.type === 'Interpret')).toMatchObject({
    packet: { derivedInlineOutputs: expect.any(Array), effectOrdinals: expect.any(Array) },
  });
  const native = a.observe().native;
  b.receive(a.document.store.encodeUpdate());
  expect(b.observe()).toEqual(a.observe());
  const undo = control(a, result, false);
  expect(a.markdown()).toBe(before);
  expect(compareBytes(a.observe().native, native)).toBe(0);
  control(a, result, true, undo);
  expect(a.markdown()).toBe(converted);
  for (const p of [b, c]) {
    p.receive(a.document.store.encodeUpdate());
    p.receive(a.document.store.encodeUpdate());
    expect(p.observe()).toEqual(a.observe());
    const cold = commandReplica(genesis, p.document.store.encodeUpdate());
    try {
      expect(cold.observe()).toEqual(p.observe());
    } finally {
      cold.close();
    }
  }
});
test('a losing packet retracts transfers/properties while peer home typing preserves a plain scaffold', () => {
  const { a, b, c } = peers();
  const result = convert(a, 'first\n\n# ');
  b.receive(a.document.store.encodeUpdate());
  const output = b.nodes()[1];
  b.editor.edit({ local: 'peer', group: 1n }, insertText, {
    nodeId: b.handle(output),
    from: output.content.length,
    text: '!',
  });
  // Explicitly supersede the same source without adding/deleting any text.
  c.receive(a.document.store.encodeUpdate());
  const original = result.envelope.effects.find((e) => e.type === 'Interpret');
  if (original?.type !== 'Interpret') throw new Error();
  c.editor.edit({ local: 'competitor', group: 1n }, insertText, {
    nodeId: c.handle(c.nodes()[0]),
    from: 0,
    text: 'C',
  });
  const ready = c.document.store.snapshot().ready;
  const last = ready.find((a) => a.id.actor !== result.action.actor)!;
  const packetId = {
    kind: 'interpretation' as const,
    birth: { type: 'action' as const, action: { ...last.id, sequence: last.id.sequence + 1n } },
    ordinal: 0,
  };
  const competitor: ActionEnvelope = {
    ...last,
    id: packetId.birth.action,
    lamport: last.lamport + 1n,
    dependencies: [last.id],
    groupId: { ...last.groupId, sequence: 2n },
    allocations: [{ type: 'interpretation', id: packetId }],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects: [
      {
        type: 'Interpret',
        packet: {
          ...original.packet,
          id: packetId,
          properties: { presentation: 'code', marker: null, info: null },
          wrappers: [],
          placements: [],
          syntaxMask: [],
          synthesizedText: [],
          derivedInlineOutputs: undefined,
          effectOrdinals: undefined,
        },
      },
    ],
  };
  // Optional wire fields are omitted, never written as undefined.
  const e = competitor.effects[0];
  if (e.type === 'Interpret') {
    delete (e.packet as { derivedInlineOutputs?: unknown }).derivedInlineOutputs;
    delete (e.packet as { effectOrdinals?: unknown }).effectOrdinals;
  }
  c.document.certifyLocal(competitor);
  c.document.store.append(competitor);
  c.editor.refresh();
  a.receive(c.document.store.encodeUpdate());
  expect(a.nodes().map((n) => [n.type, n.content])).toEqual([['code-block', 'Cfirst\n\n# ']]);
  for (const p of [a, c]) p.receive(b.document.store.encodeUpdate());
  b.receive(c.document.store.encodeUpdate());
  expect(a.nodes().map((n) => [n.type, n.content])).toEqual([
    ['paragraph', '!'],
    ['code-block', 'Cfirst\n\n# '],
  ]);
  expect(a.observe()).toEqual(b.observe());
  expect(a.observe()).toEqual(c.observe());
});

test('same-action type/convert/independent-transfer retains exact origins and replays independently', async () => {
  const { interpretMarkdown } = await import('./interpret.js');
  const { a, b, c } = peers();
  const nodeId = a.handle(a.nodes()[0]);
  const source = 'first\n\n# second';
  const result = a.editor.edit(
    { local: 'composed', group: 1n },
    (ctx) => {
      insertText(ctx, { nodeId, from: 0, to: 6, text: source });
      const [first, second] = interpretMarkdown(
        ctx,
        nodeId,
        parseBlocks(source, { provenance: true }).provenance,
      );
      ctx.draft.transferInlineRange({
        source: second,
        from: 0,
        to: 2,
        destination: first,
        at: 5,
        affinity: 'right',
      });
      return { status: 'handled', focus: ctx.draft.bookmark(first, 7, 'right') };
    },
    undefined,
  );
  expect(result.status).toBe('applied');
  expect(a.nodes().map((n) => n.content)).toEqual(['firstse', 'cond']);
  if (result.status !== 'applied') throw new Error();
  const effects = result.envelope.effects,
    packet = effects.find((e) => e.type === 'Interpret');
  if (packet?.type !== 'Interpret') throw new Error();
  expect(effects.at(-1)?.type).toBe('TransferRange');
  expect(packet.packet.effectOrdinals).not.toContain(effects.length - 1);
  for (const p of [b, c]) {
    p.receive(a.document.store.encodeUpdate());
    expect(p.observe()).toEqual(a.observe());
  }
});

test('two output newline synthesis requests allocate distinct identities once and cold replay', () => {
  const { genesis, a, b } = peers(),
    nodeId = a.handle(a.nodes()[0]);
  const plan = {
    output: {
      type: 'document' as const,
      children: [
        { type: 'paragraph' as const, content: 'a\n' },
        { type: 'paragraph' as const, content: 'a\n' },
      ],
    },
    inlinePieces: {
      '0': [
        { kind: 'retain' as const, sourceFrom: 0, sourceTo: 1 },
        { kind: 'synthesize' as const, text: '\n' },
      ],
      '1': [
        { kind: 'retain' as const, sourceFrom: 1, sourceTo: 2 },
        { kind: 'synthesize' as const, text: '\n' },
      ],
    },
    consumed: [],
  };
  const result = a.editor.edit(
    { local: 'synthesis', group: 1n },
    insertText,
    { nodeId, from: 0, to: 6, text: 'aa' },
    { conversion: { nodeId, plan } },
  );
  expect(result.status).toBe('applied');
  expect(a.nodes().map((n) => n.content)).toEqual(['a\n', 'a\n']);
  if (result.status !== 'applied') throw new Error();
  const packet = result.envelope.effects.find((e) => e.type === 'Interpret');
  if (packet?.type !== 'Interpret') throw new Error();
  expect(packet.packet.synthesizedText).toHaveLength(2);
  expect(new Set(packet.packet.synthesizedText.map((r) => `${r.client}:${r.clock}`)).size).toBe(2);
  b.receive(a.document.store.encodeUpdate());
  expect(b.observe()).toEqual(a.observe());
  const cold = commandReplica(genesis, b.document.store.encodeUpdate());
  try {
    expect(cold.observe()).toEqual(a.observe());
  } finally {
    cold.close();
  }
});

test('same-action independent task toggle is not a member of parser initialization', async () => {
  const { interpretMarkdown } = await import('./interpret.js');
  const { cycleTaskState } = await import('../../../editing/commands/cycle-task-state.js');
  const { a, b } = peers(),
    nodeId = a.handle(a.nodes()[0]),
    source = '- [x] task\n- [ ] other';
  const result = a.editor.edit(
    { local: 'task', group: 1n },
    (ctx) => {
      insertText(ctx, { nodeId, from: 0, to: 6, text: source });
      const handles = interpretMarkdown(
        ctx,
        nodeId,
        parseBlocks(source, { provenance: true }).provenance,
      );
      return cycleTaskState(ctx, { nodeId: handles[1] });
    },
    undefined,
  );
  expect(result.status).toBe('applied');
  expect(a.markdown()).toBe('- task\n- [ ] other\n');
  if (result.status !== 'applied') throw new Error();
  const packet = result.envelope.effects.find((e) => e.type === 'Interpret');
  if (packet?.type !== 'Interpret') throw new Error();
  expect(packet.packet.effectOrdinals).not.toContain(result.envelope.effects.length - 1);
  b.receive(a.document.store.encodeUpdate());
  expect(b.observe()).toEqual(a.observe());
});

function supersedeWithCode(
  p: CommandReplica,
  result: Extract<LocalEditResult, { status: 'applied' }>,
) {
  const interpretation = result.envelope.effects.find((e) => e.type === 'Interpret');
  if (interpretation?.type !== 'Interpret') throw new Error();
  const actor = actorId('ffffffffffffffffffffffffffffffff'),
    id = { actor, sequence: 1n },
    packetId = {
      kind: 'interpretation' as const,
      birth: { type: 'action' as const, action: id },
      ordinal: 0,
    };
  const ready = p.document.store.snapshot().ready;
  const action: ActionEnvelope = {
    protocolVersion: 3,
    documentId: 'D',
    genesisId: 'G',
    id,
    lamport: ready.reduce((n, a) => (a.lamport > n ? a.lamport : n), 0n) + 1n,
    dependencies: p.document.publication.status().publication!.heads,
    groupId: { session: { actor, local: 'code' }, sequence: 1n },
    allocations: [{ type: 'interpretation', id: packetId }],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects: [
      {
        type: 'Interpret',
        packet: {
          id: packetId,
          source: interpretation.packet.source,
          properties: { presentation: 'code', marker: null, info: null },
          wrappers: [],
          placements: [],
          syntaxMask: [],
          synthesizedText: [],
        },
      },
    ],
  };
  p.document.certifyLocal(action);
  p.document.store.append(action);
  p.editor.refresh();
}

test.each(['transfer', 'task', 'paste'] as const)(
  'losing parser membership preserves an independent same-action %s',
  async (kind) => {
    const { interpretMarkdown } = await import('./interpret.js');
    const { genesis, a, b, c } = peers(),
      nodeId = a.handle(a.nodes()[0]),
      source =
        kind === 'transfer'
          ? 'first\n\n# second'
          : kind === 'task'
            ? '- [x] task\n- [ ] other'
            : '```js\ncode\n```';
    const result = a.editor.edit(
      { local: 'independent', group: 1n },
      (ctx) => {
        insertText(ctx, { nodeId, from: 0, to: 6, text: source });
        const handles = interpretMarkdown(
          ctx,
          nodeId,
          parseBlocks(source, { provenance: true }).provenance,
        );
        if (kind === 'transfer')
          ctx.draft.transferInlineRange({
            source: handles[1],
            from: 0,
            to: 2,
            destination: nodeId,
            at: 5,
            affinity: 'right',
          });
        else if (kind === 'task') ctx.draft.setChecked(handles[1], false);
        else insertMarkdown(ctx, { contextId: nodeId, markdown: 'pasted\n\ntail' });
        return { status: 'handled' };
      },
      undefined,
    );
    if (result.status !== 'applied') throw new Error();
    const last = result.envelope.effects.at(-1)!;
    b.receive(a.document.store.encodeUpdate());
    supersedeWithCode(b, result);
    c.receive(b.document.store.encodeUpdate());
    a.receive(b.document.store.encodeUpdate());
    const state = a.document.publication.status().publication!.value;
    expect(
      state.activity.isEffectActive({
        action: result.action,
        ordinal: result.envelope.effects.length - 1,
      }),
    ).toBe(true);
    if (kind === 'transfer') expect(a.nodes().map((n) => n.content)).toEqual(['firstse\n\n# cond']);
    else if (kind === 'task') {
      if (last.type !== 'SetProperties') throw new Error();
      expect(state.interpretations.properties(last.node).checked).toBe(false);
      expect(a.nodes().map((n) => n.content)).toEqual([source]);
    } else
      // The paste follows the retained Interpret occurrence. When that packet
      // loses, its followers stay there and the source returns to its older edge.
      expect(a.nodes().map((n) => [n.type, n.content])).toEqual([
        ['paragraph', 'pasted'],
        ['paragraph', 'tail'],
        ['code-block', source],
      ]);
    expect(a.observe()).toEqual(b.observe());
    expect(a.observe()).toEqual(c.observe());
    const cold = commandReplica(genesis, a.document.store.encodeUpdate());
    try {
      expect(cold.observe()).toEqual(a.observe());
    } finally {
      cold.close();
    }
  },
);
