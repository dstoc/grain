import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { commandViewIndex } from '../authoring/view-index.js';
import type { ViewNode } from '../projection/types.js';
import { resourceKey } from '../layout/index.js';
import { resource } from '../actions/test-fixtures.js';
import { captureDiagnostics } from '../diagnostics.js';
import { IndexedCommandView } from './view-index.js';

function equalIndex(index: IndexedCommandView, root: ViewNode) {
  const full = commandViewIndex(root);
  const entries = [...full.origins];
  expect([...index.origins]).toEqual(entries);
  for (const [handle, node] of entries) {
    expect(index.origins.get(handle)).toBe(node);
    expect(index.handleOrigin(node.origin.representative)).toBe(handle);
    expect(index.handle(node)).toBe(handle);
    expect(index.parents.get(handle)).toEqual(full.parents.get(handle));
    expect(index.siblings.get(handle)).toEqual(full.siblings.get(handle));
  }
  for (const handle of [
    'construction:-1',
    'construction:01',
    `construction:${entries.length}`,
    'construction:Infinity',
  ])
    expect(index.origins.get(handle)).toBeUndefined();
}

test('preorder rank/select keeps publication-local handles across insert, remove, move and nested size changes', () => {
  const p = commandReplica(commandGenesis('head\n\n> a\n>\n> b\n\n- c\n- d\n\ntail'));
  try {
    let root = p.view().root,
      index = IndexedCommandView.create(root);
    const held = index,
      heldRoot = root;
    equalIndex(index, root);
    const tail = root.children.at(-1)!;
    const inserted = {
      ...root.children[0],
      origin: {
        type: 'node' as const,
        representative: resource('node', 800),
        constituents: [resource('node', 800)],
      },
    };
    const schedules = [
      (r: ViewNode) => ({ ...r, children: [inserted, ...r.children] }),
      (r: ViewNode) => ({ ...r, children: r.children.slice(1) }),
      (r: ViewNode) => ({ ...r, children: [...r.children.slice(1), r.children[0]] }),
      (r: ViewNode) => ({
        ...r,
        children: r.children.map((n) =>
          n.type === 'block-quote' ? { ...n, children: n.children.slice(1) } : n,
        ),
      }),
      (r: ViewNode) => ({
        ...r,
        children: r.children.map((n) =>
          n.type === 'list' ? { ...n, children: [...n.children].reverse() } : n,
        ),
      }),
      (r: ViewNode) => ({
        ...r,
        children: r.children.map((n) => (n === tail ? { ...n, content: '!' } : n)),
      }),
    ];
    for (const change of schedules) {
      root = change(root);
      index = index.refine(root);
      equalIndex(index, root);
      equalIndex(held, heldRoot);
    }
    expect(index.handleOrigin(resource('node', 800))).toBeUndefined();
  } finally {
    p.close();
  }
});

test('one changed subtree preserves distant records and does not construct or lazily enumerate a handle map', () => {
  const p = commandReplica(
    commandGenesis(Array.from({ length: 150 }, (_, i) => `p${i}`).join('\n\n')),
  );
  try {
    const root = p.view().root,
      held = IndexedCommandView.create(root);
    const tail = root.children.at(-1)!;
    const inserted = {
      ...root.children[0],
      origin: {
        type: 'node' as const,
        representative: resource('node', 900),
        constituents: [resource('node', 900)],
      },
    };
    const nextRoot = { ...root, children: [inserted, ...root.children] };
    const { value: index, report } = captureDiagnostics(() => {
      const next = held.refine(nextRoot);
      expect(next.handleOrigin(tail.origin.representative)).toBe('construction:151');
      expect(next.origins.get('construction:151')).toBe(tail);
      return next;
    });
    expect(report.work['driver/command.fullIndexesConstructed'] ?? 0).toBe(0);
    expect(report.work['driver/command.viewRecordsIndexed']).toBe(2);
    expect(report.work['driver/command.explicitRecordsEnumerated'] ?? 0).toBe(0);
    expect(report.work['driver/command.orderNodesRead']).toBeLessThan(40);
    expect(held.handleOrigin(tail.origin.representative)).toBe('construction:150');
    equalIndex(index, nextRoot);
  } finally {
    p.close();
  }
});

test('repeated insertions into the same gap keep all preorder ranks and old publications readable', () => {
  const p = commandReplica(commandGenesis('left\n\nright'));
  try {
    let root = p.view().root,
      index = IndexedCommandView.create(root);
    const held = index,
      original = root;
    for (let i = 0; i < 300; i++) {
      const origin = resource('node', 1000 + i);
      const node = {
        ...root.children[0],
        origin: { type: 'node' as const, representative: origin, constituents: [origin] },
      };
      root = { ...root, children: [root.children[0], node, ...root.children.slice(1)] };
      index = index.refine(root);
      expect(index.handle(node)).toBe('construction:2');
    }
    equalIndex(index, root);
    equalIndex(held, original);
    expect(
      new Set([...index.origins].map(([, n]) => resourceKey(n.origin.representative))).size,
    ).toBe(303);
  } finally {
    p.close();
  }
});

test('shape-preserving content updates replace only supplied records without inspecting sibling arrays', () => {
  const p = commandReplica(
    commandGenesis(Array.from({ length: 150 }, (_, i) => `p${i}`).join('\n\n')),
  );
  try {
    const root = p.view().root,
      index = IndexedCommandView.create(root),
      first = { ...root.children[0], content: '!' };
    const nextRoot = { ...root, children: [first, ...root.children.slice(1)] };
    const { value: next, report } = captureDiagnostics(() =>
      index.replaceRecords([first, nextRoot]),
    );
    expect(report.work['driver/command.viewRecordsIndexed']).toBe(2);
    expect(report.work['driver/command.childArrayEntriesInspected'] ?? 0).toBe(0);
    expect(report.work['driver/command.fullIndexesConstructed'] ?? 0).toBe(0);
    equalIndex(next, nextRoot);
    equalIndex(index, root);
  } finally {
    p.close();
  }
});
