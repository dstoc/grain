import { afterEach, expect, test, vi } from 'vitest';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { nativeView } from '../ingest/publication.js';
import { resource } from '../actions/test-fixtures.js';
import * as layout from '../layout/index.js';
import { projectMarkdown } from './project.js';

afterEach(() => vi.restoreAllMocks());
for (const size of [10, 150])
  test(`initial property validation indexes node origins among ${size} nodes`, () => {
    const f = new NativeFixture([
      { id: 'root', role: 'root', parent: null },
      ...Array.from({ length: size }, (_, i) => ({
        id: `P${i}`,
        role: 'inline' as const,
        parent: 'root',
        flow: `f${i}`,
        run: `r${i}`,
        tape: `t${i}`,
        cells: [],
      })),
    ]);
    try {
      const native = nativeView(f.peers.get('A')!);
      const initialProperties = Array.from({ length: size }, (_, i) => ({
        node: f.id(`P${i}`, 'node'),
        values: {},
      }));
      const key = vi.spyOn(layout, 'resourceKey');
      expect(() =>
        projectMarkdown({
          genesis: f.genesis,
          genesisManifest: f.bodies.get('G')!.nativeManifest,
          actions: [],
          birthContent: [],
          initialProperties,
          native: {
            ...native,
            snapshot() {
              throw new Error('native snapshot boundary reached');
            },
          },
        }),
      ).toThrow('native snapshot boundary reached');
      expect(key.mock.calls.length).toBeLessThan(size * 5);
    } finally {
      f.destroy();
    }
  });

test('initial property validation still rejects duplicate and unknown retained origins before native reads', () => {
  const f = new NativeFixture();
  try {
    const native = nativeView(f.peers.get('A')!),
      snapshot = vi.fn(native.snapshot),
      node = f.id('P', 'node');
    for (const initialProperties of [
      [
        { node, values: {} },
        { node, values: {} },
      ],
      [{ node: resource('node', 99999), values: {} }],
    ]) {
      expect(() =>
        projectMarkdown({
          genesis: f.genesis,
          genesisManifest: f.bodies.get('G')!.nativeManifest,
          actions: [],
          birthContent: [],
          initialProperties,
          native: { ...native, snapshot },
        }),
      ).toThrow('Initial properties require unique retained node origins');
    }
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    f.destroy();
  }
});
