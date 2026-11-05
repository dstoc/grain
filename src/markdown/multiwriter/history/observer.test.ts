import { expect, test } from 'vitest';
import { replica, type } from '../../../../test/multiwriter/history.js';
import { RetainedEditError } from '../authoring/index.js';

for (const phase of ['edit', 'control'] as const)
  for (const fail of [false, true])
    test(`real canonical observer ${fail ? 'throws' : 'succeeds'} during ${phase}; later history agrees with cold replay`, () => {
      const a = replica('abc'),
        h = a.editor.session();
      type(a, 'x', 3, { typing: true });
      if (phase === 'control') type(a, 'y', 4, { typing: true });
      const dispose = a.document.store.onUpdate(() => {
        if (fail) throw new Error('observer');
      });
      const invoke = () => (phase === 'edit' ? type(a, 'y', 4, { typing: true }) : h.undo());
      if (fail) expect(invoke).toThrow(RetainedEditError);
      else invoke();
      dispose();
      a.editor.refresh();
      expect(h.groups()[phase === 'edit' ? 'undo' : 'redo'][0].actions).toHaveLength(2);
      expect(a.nodes()[0].content).toBe(phase === 'edit' ? 'abcxy' : 'abc');
      expect(h.status()).toMatchObject(
        phase === 'edit' ? { undo: 1, redo: 0 } : { undo: 0, redo: 1 },
      );
      expect(a.document.store.snapshot().ready).toHaveLength(phase === 'edit' ? 2 : 3);
      const next = phase === 'edit' ? h.undo() : h.redo();
      expect(next).toMatchObject({ state: 'applied' });
      const cold = replica('', a.genesis, a.document.store.encodeUpdate());
      expect(cold.nodes()[0].content).toBe(phase === 'edit' ? 'abc' : 'abcxy');
      expect(a.nodes()[0].content).toBe(cold.nodes()[0].content);
      expect(a.document.store.snapshot().ready).toEqual(cold.document.store.snapshot().ready);
      expect(h.status()).toMatchObject(
        phase === 'edit' ? { undo: 0, redo: 1 } : { undo: 1, redo: 0 },
      );
      expect((phase === 'edit' ? h.redo() : h.undo()).state).toBe('applied');
      expect(a.nodes()[0].content).toBe(phase === 'edit' ? 'abcxy' : 'abc');
      expect((phase === 'edit' ? h.undo() : h.redo()).state).toBe('applied');
      expect(() => type(a, '!')).not.toThrow();
      expect(h.status()).toMatchObject(
        phase === 'edit' ? { undo: 1, redo: 0 } : { undo: 2, redo: 0 },
      );
      const final = replica('', a.genesis, a.document.store.encodeUpdate());
      expect(a.markdown()).toBe(final.markdown());
      expect(a.document.store.snapshot()).toEqual(final.document.store.snapshot());
      expect(a.document.store.snapshot().ready).toHaveLength(phase === 'edit' ? 6 : 7);
    });
