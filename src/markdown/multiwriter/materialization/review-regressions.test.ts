import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { seed, change } from '../../../../test/multiwriter/projection-consumer.js';
import { commandViewIndex } from '../authoring/view-index.js';
import type { CommandViewIndex } from '../authoring/view-index.js';
import type { ViewNode } from '../projection/types.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { captureDiagnostics } from '../diagnostics.js';
import { resourceKey } from '../layout/index.js';

function equalIndex(index: CommandViewIndex, root: ViewNode) {
  const full = commandViewIndex(structuredClone(root)),
    entries = [...full.origins];
  expect([...index.origins]).toEqual(entries);
  expect([...index.origins.keys()]).toEqual(entries.map(([id]) => id));
  for (const [handle, node] of entries) {
    expect(index.origins.get(handle)).toEqual(node);
    expect(index.origins.has(handle)).toBe(true);
    expect(index.handle(node)).toBe(handle);
    expect(index.handleOrigin(node.origin.representative)).toBe(handle);
    expect(index.parents.get(handle)).toEqual(full.parents.get(handle));
    expect(index.siblings.get(handle)).toEqual(full.siblings.get(handle));
  }
  expect(index.origins.get(`construction:${entries.length}`)).toBeUndefined();
  expect(
    new Set([...index.origins].map(([, n]) => resourceKey(n.origin.representative))).size,
  ).toBe(entries.length);
}

for (const direction of ['earlier', 'later'] as const)
  for (const subtree of [false, true])
    test(`cross-parent move to ${direction} quote retains full command index (subtree=${subtree})`, () => {
      const markdown = subtree
        ? '> - a\n> - b\n>\n> c\n\nseparator\n\n> - x\n> - y\n>\n> z'
        : '> a\n>\n> b\n\nseparator\n\n> x\n>\n> y';
      const p = commandReplica(commandGenesis(markdown), undefined, 'materialized');
      try {
        const { consumer, value } = seed(p),
          held = structuredClone(value.view),
          heldIndex = commandViewIndex(value.view.root),
          [earlier, , later] = p.view().root.children,
          [source, destination] = direction === 'earlier' ? [later, earlier] : [earlier, later];
        const result = p.editor.edit(
          { local: 'move', group: 1n },
          (ctx, args) => {
            ctx.draft.place(args.node, args.parent, args.before);
            return { status: 'handled' };
          },
          {
            node: p.handle(source.children[0]),
            parent: p.handle(destination),
            before: subtree ? null : p.handle(destination.children.at(-1)!),
          },
        );
        expect(result.status).toBe('applied');
        const candidate = consumer.prepareStructural(change(p, value));
        expect(candidate.state).toBe('prepared');
        if (candidate.state !== 'prepared') throw new Error(candidate.reason);
        const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference');
        try {
          expect(candidate.value.view).toEqual(cold.view());
          expect(p.view()).toEqual(cold.view());
          equalIndex(commandViewIndex(p.view().root), cold.view().root);
          equalIndex(commandViewIndex(candidate.value.view.root), cold.view().root);
          equalIndex(heldIndex, held.root);
          candidate.commit();
          expect(value.view).toEqual(held);
          equalIndex(heldIndex, held.root);
        } finally {
          cold.close();
        }
      } finally {
        p.close();
      }
    });

test('checked-property undo and redo publish candidate values against an independent reference', () => {
  const p = commandReplica(commandGenesis('- [ ] task\n\ntail'), undefined, 'materialized');
  try {
    const item = p.view().root.children[0].children[0],
      changed = p.editor.edit(
        { local: 'checkbox', group: 1n },
        (ctx, args) => {
          ctx.draft.setChecked(args.node, true);
          return { status: 'handled' };
        },
        { node: p.handle(item) },
      );
    expect(changed.status).toBe('applied');
    if (changed.status !== 'applied') throw new Error('Expected applied checkbox');
    const { consumer, value: initial } = seed(p),
      held = structuredClone(initial.view);
    let value = initial;
    const undo = control(p, changed, false);
    for (const checked of [false, true]) {
      if (checked) control(p, changed, true, undo);
      const candidate = consumer.prepareStructural(change(p, value));
      expect(candidate.state).toBe('prepared');
      if (candidate.state !== 'prepared') throw new Error(candidate.reason);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference');
      try {
        expect(cold.view().root.children[0].children[0].checked).toBe(checked);
        expect(p.view()).toEqual(cold.view());
        expect(candidate.value.view).toEqual(cold.view());
        const reference = cold.document.publication.status().publication!.value;
        expect(candidate.value.visibility).toEqual(reference.visibility);
        expect(p.document.publication.status().publication!.value.visibility).toEqual(
          reference.visibility,
        );
        expect(candidate.value.interpretations.properties(item.origin.representative)).toEqual(
          reference.interpretations.properties(item.origin.representative),
        );
        equalIndex(commandViewIndex(candidate.value.view.root), cold.view().root);
        candidate.commit();
        value = candidate.value;
        expect(initial.view).toEqual(held);
      } finally {
        cold.close();
      }
    }
  } finally {
    p.close();
  }
});

test('earlier concurrent allocation preserves complete visibility export order without preparation enumeration', () => {
  const genesis = commandGenesis('abcdef\n\nuvwxyz\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis);
  try {
    expect(
      p.editor.edit({ local: 'tick', group: 1n }, insertText, {
        nodeId: p.handle(p.nodes()[2]),
        from: 1,
        text: '!',
      }).status,
    ).toBe('applied');
    expect(
      p.editor.edit({ local: 'local-split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }).status,
    ).toBe('applied');
    const { consumer, value } = seed(p),
      heldVisibility = structuredClone(value.visibility),
      heldView = structuredClone(value.view);
    expect(
      peer.editor.edit({ local: 'peer-split', group: 1n }, insertParagraph, {
        nodeId: peer.handle(peer.nodes()[1]),
        from: 3,
      }).status,
    ).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    const input = change(p, value);
    expect(input.action.lamport).toBeLessThan(input.actions.at(-1)!.lamport);
    const { value: candidate, report } = captureDiagnostics(() =>
      consumer.prepareStructural(input),
    );
    expect(candidate.state).toBe('prepared');
    if (candidate.state !== 'prepared') throw new Error(candidate.reason);
    for (const name of [
      'projection.orderGroupsExported',
      'projection.visibilityNodesExported',
      'projection.visibilityTapesExported',
      'projection.fullProjectors',
      'provenance.fullReconstructions',
    ])
      expect(report.work[`driver/${name}`] ?? 0, name).toBe(0);
    const cold = commandReplica(genesis, p.document.store.encodeUpdate(), 'reference');
    try {
      const reference = cold.document.publication.status().publication!.value;
      expect(candidate.value.view).toEqual(reference.view);
      expect(candidate.value.visibility).toEqual(reference.visibility);
      expect(p.document.publication.status().publication!.value.visibility).toEqual(
        reference.visibility,
      );
      equalIndex(commandViewIndex(candidate.value.view.root), reference.view.root);
      candidate.commit();
      expect(value.visibility).toEqual(heldVisibility);
      expect(value.view).toEqual(heldView);
    } finally {
      cold.close();
    }
  } finally {
    peer.close();
    p.close();
  }
});
