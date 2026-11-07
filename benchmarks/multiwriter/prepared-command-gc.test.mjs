import assert from 'node:assert/strict';
import test from 'node:test';
import { commandGenesis, commandReplica } from '../../test/multiwriter/commands/replica.ts';
import { enter } from '../../src/markdown/multiwriter/authoring/index.ts';
import { compareBytes } from '../../src/markdown/multiwriter/actions/cbor.ts';

function exercise(mode, handles, retired, held) {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  const publication = p.document.publication.status().publication;
  held.push({
    publication,
    view: structuredClone(publication.value.view),
    native: publication.native.encodeState(),
  });
  retired.push(
    new WeakRef(p.document),
    new WeakRef(p.document.store),
    new WeakRef(p.document.publication),
    new WeakRef(p.editor),
  );
  const prepare = p.document.prepareLocalAction.bind(p.document);
  p.document.prepareLocalAction = (action) => {
    const candidate = prepare(action);
    if (candidate) {
      handles.push(candidate);
      if (mode === 'cancel') candidate.cancel();
      if (mode === 'evict') p.document.publication.evict();
    }
    return candidate;
  };
  const stop =
    mode === 'retained'
      ? p.document.store.onUpdate(() => {
          throw new Error('retained observer');
        })
      : () => {};
  try {
    const edit = () => p.editor.session().edit(enter, { nodeId: p.handle(p.nodes()[0]), from: 2 });
    if (mode === 'success') assert.equal(edit().status, 'applied');
    else assert.throws(edit);
    stop();
    if (mode === 'retained') p.editor.refresh();
  } finally {
    stop();
    p.close();
  }
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
test('expired structural candidate handles release live owners while held results remain readable', async () => {
  assert.equal(typeof global.gc, 'function');
  const handles = [],
    retired = [],
    held = [];
  for (let i = 0; i < 12; i++)
    exercise(['success', 'cancel', 'evict', 'retained'][i % 4], handles, retired, held);
  for (let i = 0; i < 30; i++) {
    await turn();
    global.gc();
    global.gc();
    if (retired.every((ref) => !ref.deref())) break;
  }
  assert.equal(retired.filter((ref) => ref.deref()).length, 0);
  assert.equal(handles.length, 12);
  for (const handle of handles) {
    assert.throws(() => handle.assertCurrent({}), /no longer current/);
    handle.cancel();
    assert(handle.publication.native.encodeState().length > 0);
  }
  for (const saved of held) {
    assert.deepEqual(saved.publication.value.view, saved.view);
    assert.equal(compareBytes(saved.publication.native.encodeState(), saved.native), 0);
  }
  console.info(
    JSON.stringify({
      attempts: 12,
      heldExpiredHandles: handles.length,
      releasedOwners: retired.length,
      heldResultsReadable: true,
    }),
  );
});
