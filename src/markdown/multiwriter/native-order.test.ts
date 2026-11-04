import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { contractCorpus } from '../../../test/multiwriter/corpus.js';

/** Calibrate only the native-order assumption in the fixtures, not the combined reducer. */
it('calibrates shared-empty-genesis order against pinned Yjs with A client < B client', () => {
  const genesis = new Y.Doc({ gc: false });
  const a = new Y.Doc({ gc: false });
  const b = new Y.Doc({ gc: false });
  try {
    genesis.clientID = 1;
    a.clientID = 2;
    b.clientID = 3;
    const seed = genesis.getText('tP');
    seed.insertEmbed(0, { boundary: 'start' });
    seed.insertEmbed(1, { boundary: 'end' });
    const bootstrap = Y.encodeStateAsUpdate(genesis);
    Y.applyUpdate(a, bootstrap);
    Y.applyUpdate(b, bootstrap);
    a.getText('tP').insert(1, 'x');
    b.getText('tP').insert(1, 'y');
    const aUpdate = Y.encodeStateAsUpdate(a);
    const bUpdate = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, bUpdate);
    Y.applyUpdate(b, aUpdate);
    const fixture = contractCorpus.find((trace) => trace.id === 'shared-empty-genesis')!;
    const expected = fixture.steps.find((step) => step.type === 'expect' && step.state.markdown);
    if (expected?.type !== 'expect') throw new Error('Missing shared-empty expectation');
    expect(a.getText('tP').toString() + '\n').toBe(expected.state.markdown);
    expect(b.getText('tP').toString() + '\n').toBe(expected.state.markdown);
    expect(a.getText('tP').toDelta()).toEqual([
      { insert: { boundary: 'start' } },
      { insert: 'xy' },
      { insert: { boundary: 'end' } },
    ]);
  } finally {
    genesis.destroy();
    a.destroy();
    b.destroy();
  }
});
