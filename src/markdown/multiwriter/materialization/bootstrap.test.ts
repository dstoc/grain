import { expect, test } from 'vitest';
import { createGenesis, decodeGenesis, decodeBundle, openBootstrap } from '../bootstrap/index.js';
import type { BootstrapOpenOptions } from '../bootstrap/index.js';
import { referenceGenesis } from '../bootstrap/descriptor.js';
import { LocalEditor } from '../authoring/editor.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { compareBytes } from '../actions/cbor.js';
import { serializeProjection } from '../projection/project.js';
import { MaterializedPublication } from './publication.js';

const genesis = createGenesis('selected-reader', 'abc\n\ntail');
test('bootstrap local selection edits, persists and cold-opens through the independent reference reader', async () => {
  const updates: Uint8Array[] = [];
  const journal = () => ({
    read: async () => updates.map((u) => u.slice()),
    append: async (u: Uint8Array) => {
      updates.push(u.slice());
    },
    close() {},
  });
  const selected = await openBootstrap({
    genesis,
    persistedGenesis: genesis,
    materialization: 'incremental-native',
    mode: 'outbound-only',
    journal: journal(),
  });
  const writer = new LocalEditor(selected.document, referenceGenesis(decodeGenesis(genesis)));
  let canonical: Uint8Array, native: Uint8Array;
  try {
    expect(selected.document.publication).toBeInstanceOf(MaterializedPublication);
    const node = selected.document.publication.status().publication!.value.view.root.children[0];
    expect(
      writer.edit({ local: 'bootstrap', group: 1n }, insertText, {
        nodeId: writer.handle(node.origin.representative),
        from: 1,
        text: 'X',
      }).status,
    ).toBe('applied');
    await selected.provider.flush();
    canonical = selected.document.store.encodeUpdate();
    native = selected.document.publication.status().publication!.native.encodeState();
    const bundle = decodeBundle(selected.captureBundle());
    expect(Object.keys(bundle).sort()).toEqual(['actionUpdate', 'genesis']);
    expect(compareBytes(bundle.genesis, genesis)).toBe(0);
  } finally {
    writer.destroy();
    await selected.close();
  }
  const reference = await openBootstrap({
    genesis,
    persistedGenesis: genesis,
    mode: 'disconnected',
    journal: journal(),
  });
  try {
    expect(reference.document.publication).not.toBeInstanceOf(MaterializedPublication);
    const p = reference.document.publication.status().publication!;
    expect(serializeProjection(p.value.view)).toBe('aXbc\n\ntail\n');
    expect(compareBytes(reference.document.store.encodeUpdate(), canonical!)).toBe(0);
    expect(compareBytes(p.native.encodeState(), native!)).toBe(0);
  } finally {
    await reference.close();
  }
});

test('unknown local materialization fails before attaching a journal', async () => {
  let reads = 0;
  const options = {
    genesis,
    persistedGenesis: genesis,
    mode: 'disconnected',
    materialization: 'unknown',
    journal: {
      read: async () => {
        reads++;
        return [];
      },
      append: async () => {},
      close() {},
    },
  } as unknown as BootstrapOpenOptions;
  await expect(openBootstrap(options)).rejects.toThrow('Unknown local materialization');
  expect(reads).toBe(0);
});
