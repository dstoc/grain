import assert from 'node:assert/strict';
import test from 'node:test';
import { commandGenesis, commandReplica } from '../../test/multiwriter/commands/replica.ts';
import { insertParagraph } from '../../src/markdown/multiwriter/authoring/index.ts';
import { MaterializedOwnership } from '../../src/markdown/multiwriter/materialization/coupled.ts';
import { compareBytes } from '../../src/markdown/multiwriter/actions/cbor.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
test('held expired proofs release author forks/native attempts after success, miss and post-mint failure', async () => {
  assert.equal(typeof global.gc, 'function');
  const peer = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  const held = peer.document.publication.status().publication;
  const heldView = structuredClone(held.value.view),
    heldNative = held.native.encodeState();
  const original = MaterializedOwnership.prototype.prepareAuthor;
  const retired = [],
    proofs = [];
  let mode = 'success';
  MaterializedOwnership.prototype.prepareAuthor = function* (...args) {
    retired.push(new WeakRef(this), new WeakRef(args[0].native), new WeakRef(args[5].native));
    if (mode === 'miss') return { state: 'unavailable', reason: 'gc-control' };
    const result = yield* original.apply(this, args);
    if (result.state === 'proved') proofs.push(result.proof);
    if (mode === 'post-mint-failure') throw new Error('post-mint fault');
    return result;
  };
  try {
    for (let i = 0; i < 12; i++) {
      mode = i % 3 === 0 ? 'post-mint-failure' : i % 3 === 1 ? 'miss' : 'success';
      const edit = () =>
        peer.editor.session(`gc-${i}`).edit(insertParagraph, {
          nodeId: peer.handle(peer.nodes()[0]),
          from: 1,
        });
      if (mode === 'post-mint-failure') assert.throws(edit, /post-mint fault/);
      else assert.equal(edit().status, 'applied');
    }
    peer.document.publication.evict();
    peer.editor.refresh();
    for (let i = 0; i < 20; i++) {
      await turn();
      global.gc();
      global.gc();
      if (retired.every((ref) => !ref.deref())) break;
    }
    assert.equal(retired.filter((ref) => ref.deref()).length, 0);
    assert.equal(proofs.length, 8);
    assert.deepEqual(held.value.view, heldView);
    assert.equal(compareBytes(held.native.encodeState(), heldNative), 0);
    assert.ok(peer.document.ownershipDiagnostics().retainedCheckpoints <= 8);
    console.info(
      JSON.stringify({
        forkAttempts: retired.length / 3,
        heldExpiredProofs: proofs.length,
        allReleased: true,
        heldPublication: true,
      }),
    );
  } finally {
    MaterializedOwnership.prototype.prepareAuthor = original;
    peer.close();
  }
});
