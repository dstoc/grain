import { test, expect } from 'vitest';
import { CanonicalDocument } from './canonical-model.js';
import { CanonicalWriter } from './canonical-actions.js';
import { createCanonicalTextAnchor, resolveCanonicalTextAnchor } from './canonical-selection.js';
test('transmitted text anchors resolve equally after native redo and fresh reconstruction', () => {
  const document = CanonicalDocument.fromMarkdown('ab');
  const writer = new CanonicalWriter(document);
  const id = document.root.children[0]!.sharedId;
  const accepted = writer.edit({ actionId: 'insert' }, (draft) =>
    draft.spliceText(id, { from: 1, to: 1, insert: 'XY' }),
  );
  expect('receipt' in accepted).toBe(true);
  const anchor = createCanonicalTextAnchor(document, { nodeId: id, offset: 2, affinity: 'right' });
  expect(writer.undo().status).toBe('applied');
  expect(writer.redo().status).toBe('applied');
  const peer = CanonicalDocument.open(document.checkpoint());
  try {
    const local = resolveCanonicalTextAnchor(document, anchor);
    const remote = resolveCanonicalTextAnchor(peer, anchor);
    expect(remote).toEqual(local);
  } finally {
    peer.close();
    writer.close();
    document.close();
  }
});
