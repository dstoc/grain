import { afterEach, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { ConstructionTreeDraft } from '../../semantic/construction-tree.js';
import * as projection from '../projection/project.js';
import { MultiwriterCommandDraft } from '../authoring/draft.js';
import { MaterializedPublication } from './publication.js';

afterEach(() => vi.restoreAllMocks());
for (const size of [10, 150]) {
  test(`literal overlay does not construct command trees or run an intermediate full projector (${size})`, () => {
    const p = commandReplica(
      commandGenesis(Array.from({ length: size }, () => 'abc').join('\n\n')),
      undefined,
      'materialized',
    );
    try {
      const adopt = vi.spyOn(ConstructionTreeDraft.prototype, 'adopt');
      const projector = vi.spyOn(projection, 'projectWithActivity');
      const publication = p.document.publication;
      if (!(publication instanceof MaterializedPublication)) throw new Error();
      const before = publication.diagnostics();
      const result = p.editor.edit({ local: 'overlay', group: 1n }, insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 1,
        text: 'X',
      });
      expect(result.status).toBe('applied');
      expect(adopt).not.toHaveBeenCalled();
      // The single call is the explicitly retained publication fallback, outside command preparation.
      expect(projector).toHaveBeenCalledTimes(1);
      expect(publication.diagnostics().tapesIndexed - before.tapesIndexed).toBe(1);
      const oracle = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(p.observe()).toEqual(oracle.observe());
      } finally {
        oracle.close();
      }
    } finally {
      p.close();
    }
  }, 60000);
}

test('a held overlay node stays live through literal changes and structural materialization', () => {
  const p = commandReplica(commandGenesis('abc\n\ntail'));
  try {
    const draft = new MultiwriterCommandDraft(p.view().root, true);
    const first = 'construction:1',
      second = 'construction:2';
    const held = draft.node(first);
    for (const query of [
      () => draft.node('unknown'),
      () => draft.parentOf('unknown'),
      () => draft.previousSiblingOf('unknown'),
      () => draft.nextSiblingOf('unknown'),
    ])
      expect(query).toThrow('unknown construction node');
    draft.spliceText(first, { from: 1, to: 2, insert: '😀' });
    expect(held.content).toBe('a😀c');
    expect(() => draft.place(second, first, null)).toThrow('cannot be a child');
    expect(held.content).toBe('a😀c');
    draft.convertInline(first, { type: 'section', marker: '#' });
    draft.place(second, first, null);
    expect(held.type).toBe('section');
    expect(held.children).toEqual([second]);
    expect(held.content).toBe('a😀c');
  } finally {
    p.close();
  }
});

for (const kind of ['split', 'paste'] as const) {
  test(`text followed by ${kind} in one command retains overlay edits and native identities`, () => {
    const p = commandReplica(commandGenesis('abcd'), undefined, 'materialized');
    try {
      const result = p.editor.edit(
        { local: 'mixed', group: 1n },
        (context, { nodeId }: { nodeId: string }) => {
          insertText(context, { nodeId, from: 1, text: 'X' });
          return kind === 'split'
            ? insertParagraph(context, { nodeId, from: 3 })
            : insertMarkdown(context, { contextId: nodeId, markdown: '> pasted' });
        },
        { nodeId: p.handle(p.nodes()[0]) },
      );
      expect(result.status).toBe('applied');
      expect(p.nodes()[0].content).toBe(kind === 'split' ? 'aXb' : 'aXbcd');
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(p.observe()).toEqual(cold.observe());
      } finally {
        cold.close();
      }
    } finally {
      p.close();
    }
  });
}
