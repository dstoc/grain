import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

interface ObservedBoundary {
  readonly grainBoundary: string;
}

function textGroup(doc: Y.Doc, target: Y.Map<Y.Text>, edit: () => void): Y.UndoManager {
  const inputOrigin = {};
  let manager: Y.UndoManager;
  manager = new Y.UndoManager(target, {
    captureTimeout: Number.POSITIVE_INFINITY,
    trackedOrigins: new Set([inputOrigin]),
    captureTransaction: (transaction) =>
      transaction.origin === inputOrigin || transaction.origin === manager,
  });
  doc.transact(edit, inputOrigin);
  return manager;
}

describe('Yjs 13.6.33 dependency controls', () => {
  it.each([true, false])('preserves the observed upstream #823 divergence with gc=%s', (gc) => {
    const document = new Y.Doc({ gc });
    const fragment = document.getXmlFragment('f');
    const paragraph = new Y.XmlElement('p');
    const text = new Y.XmlText();
    fragment.insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, 'aword');
    const history = new Y.UndoManager(fragment, { captureTimeout: 0 });
    text.delete(1, 4);
    history.undo();
    text.insert(2, '++');
    history.stopCapturing();
    fragment.delete(0, 1);
    history.stopCapturing();
    history.undo();

    const fresh = new Y.Doc({ gc });
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(document));
    const local = fragment.toString();
    const reconstructed = fresh.getXmlFragment('f').toString();

    // This is an observed upstream dependency defect, not a convergence pass.
    expect(local).toBe('<p>aw++ord</p>');
    expect(reconstructed).toBe('<p>aordw++</p>');
    expect(reconstructed).not.toBe(local);
    history.destroy();
    document.destroy();
    fresh.destroy();
  });

  it.each(['detach-reattach', 'delete-body-undo', 'delete-body-undo-redo-undo'] as const)(
    'keeps permanent tape sentinels stable through %s',
    (action) => {
      const document = new Y.Doc({ gc: false });
      const tapes = document.getMap<Y.Text>('tapes');
      const nodes = document.getMap<Y.Map<unknown>>('nodes');
      const text = new Y.Text();
      const root = new Y.Map<unknown>();
      tapes.set('t1', text);
      nodes.set('root', root);
      root.set('children', { token: 'birth', value: ['p'] });
      text.insertEmbed(0, { grainBoundary: 'head' } satisfies ObservedBoundary);
      text.insertEmbed(1, { grainBoundary: 'tail' } satisfies ObservedBoundary);

      const initial = textGroup(document, tapes, () => text.insert(1, 'aword'));
      const deletion = textGroup(document, tapes, () => text.delete(2, 4));
      deletion.undo();
      const insertion = textGroup(document, tapes, () => text.insert(3, '++'));
      const extras: Y.UndoManager[] = [];
      if (action === 'detach-reattach') {
        root.set('children', { token: 'detached', value: [] });
        root.set('children', { token: 'birth', value: ['p'] });
      } else {
        const finalDelete = textGroup(document, tapes, () => text.delete(1, text.length - 2));
        extras.push(finalDelete);
        finalDelete.undo();
        if (action === 'delete-body-undo-redo-undo') {
          finalDelete.redo();
          finalDelete.undo();
        }
      }

      const fresh = new Y.Doc({ gc: false });
      Y.applyUpdate(fresh, Y.encodeStateAsUpdate(document));
      const freshText = fresh.getMap<Y.Text>('tapes').get('t1')!;
      let readUpdates = 0;
      document.on('update', () => readUpdates++);
      fresh.on('update', () => readUpdates++);
      const markers = (tape: Y.Text) =>
        tape
          .toDelta()
          .flatMap((part: { insert: unknown }) =>
            typeof part.insert === 'object'
              ? [(part.insert as ObservedBoundary).grainBoundary]
              : [],
          );

      expect(text.toString()).toBe('aw++ord');
      expect(freshText.toString()).toBe(text.toString());
      expect(root.get('children')).toEqual({ token: 'birth', value: ['p'] });
      const freshRoot = fresh.getMap('nodes').get('root') as Y.Map<unknown>;
      expect(freshRoot.get('children')).toEqual(root.get('children'));
      expect(markers(text)).toEqual(['head', 'tail']);
      expect(markers(freshText)).toEqual(['head', 'tail']);
      expect(readUpdates).toBe(0);

      for (const manager of [initial, deletion, insertion, ...extras]) manager.destroy();
      document.destroy();
      fresh.destroy();
    },
  );
});
