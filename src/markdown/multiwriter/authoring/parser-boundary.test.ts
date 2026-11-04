import { expect, test } from 'vitest';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { openReferenceDocument } from '../reference/document.js';
import type { ActionEnvelope, SemanticEffect } from '../contracts.js';
import type { ViewNode } from '../projection/types.js';

/** Contract probe, not an approved lowering for multi-inline conversions.
 * The source packet can own its mask/presentation. It cannot own a second inline's
 * SetProperties or a TransferRange, which remain ordinary active effects.
 */
test('a losing multi-inline packet cannot retract its additional output kind or transfer', () => {
  const text = 'first\n\n# second';
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [...text].map((text, i) => ({ id: `P${i}`, text })),
    },
  ]);
  const genesis = {
    documentId: 'D',
    genesisId: 'G',
    layout: f.genesis,
    body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
  };
  let packetA: Extract<SemanticEffect, { type: 'Interpret' }>,
    packetB: Extract<SemanticEffect, { type: 'Interpret' }>;
  f.author('A1', (f) => {
    f.createBlock(
      { id: 'N', parent: 'root', role: 'inline', flow: 'fN', run: 'rN', tape: 'tN', cells: [] },
      'P:birth',
    );
    packetA = {
      type: 'Interpret',
      packet: {
        id: f.allocate('packetA', 'interpretation'),
        source: f.id('P', 'node'),
        properties: { presentation: 'paragraph', marker: null, info: null },
        wrappers: [],
        placements: [],
        syntaxMask: [5, 6, 7, 8].map((i) => f.aliases.get(`P${i}`)!),
        synthesizedText: [],
      },
    };
    return [
      packetA,
      f.transfer(
        Array.from({ length: text.length - 7 }, (_, i) => `P${i + 7}`),
        'N:home-end',
        'parser-tail',
      ),
      {
        type: 'SetProperties',
        node: f.id('N', 'node'),
        values: { presentation: 'section', marker: '#' },
      },
    ];
  });
  f.author('B1', (f) => {
    packetB = {
      type: 'Interpret',
      packet: {
        id: f.allocate('packetB', 'interpretation'),
        source: f.id('P', 'node'),
        properties: { presentation: 'code', marker: null, info: null },
        wrappers: [],
        placements: [],
        syntaxMask: [],
        synthesizedText: [],
      },
    };
    return [packetB];
  });
  const envelope = (name: 'A1' | 'B1'): ActionEnvelope => {
    const e = f.envelope(name),
      packet = name === 'A1' ? packetA! : packetB!;
    return {
      ...e,
      allocations: [...e.allocations, { type: 'interpretation', id: packet.packet.id }],
    };
  };
  const a = openReferenceDocument(genesis),
    b = openReferenceDocument(genesis);
  const nodes = (doc: typeof a) => {
    const out: ViewNode[] = [];
    const visit = (n: ViewNode) => {
      if (n.type === 'paragraph' || n.type === 'section' || n.type === 'code-block') out.push(n);
      n.children.forEach(visit);
    };
    visit(doc.publication.status().publication!.value.view.root);
    return out;
  };
  try {
    a.publication.refresh();
    a.certifyLocal(envelope('A1'));
    a.store.append(envelope('A1'));
    a.publication.refresh();
    expect(nodes(a).map((n) => [n.type, n.content])).toEqual([
      ['paragraph', 'first'],
      ['section', 'second'],
    ]);
    b.publication.refresh();
    b.certifyLocal(envelope('B1'));
    b.store.append(envelope('B1'));
    b.publication.refresh();
    a.store.applyUpdate(b.store.encodeUpdate());
    a.publication.refresh();
    b.store.applyUpdate(a.store.encodeUpdate());
    b.publication.refresh();
    expect(a.store.snapshot().ready).toHaveLength(2);
    expect(
      a.publication.status().publication!.value.interpretations.packets.map((p) => p.id),
    ).toEqual([packetB!.packet.id]);
    expect(nodes(a).map((n) => [n.type, n.content])).toEqual([
      ['code-block', 'first\n\n'],
      ['section', '# second'],
    ]);
    expect(nodes(b)).toEqual(nodes(a));
  } finally {
    a.destroy();
    b.destroy();
    f.destroy();
  }
});
