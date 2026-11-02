import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { canonicalWriterAccess, CanonicalDocument, type CanonicalNode } from './canonical-model.js';
import { CanonicalWriter } from './canonical-actions.js';
import type { ActionRequest, AdmittedContext } from './canonical-actions.js';
import { parseBlocks } from './block-parser/api.js';
import { applyParserConversion } from './canonical-promotion.js';

function context(request: ActionRequest, sessionId = 'A'): AdmittedContext {
  return {
    sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  };
}

function accept(writer: CanonicalWriter, request: ActionRequest, sessionId = 'A') {
  const result = writer.apply(request, context(request, sessionId));
  expect(result.status, JSON.stringify(result)).toBe('pending');
  if (result.status !== 'pending')
    throw new Error(`expected pending action, got ${JSON.stringify(result)}`);
  return writer.publish(result.pending);
}

function documentFor(source: string, suffix: string) {
  return CanonicalDocument.fromMarkdown(source, {
    documentId: `promotion-${suffix}`,
    actionId: `promotion-import-${suffix}`,
    authorityEpoch: 'promotion-epoch',
  });
}

function descendants(root: CanonicalNode): CanonicalNode[] {
  return [root, ...root.children.flatMap(descendants)];
}

function visibleCharacterIds(document: CanonicalDocument, nodeId: string): string[] {
  const node = document.canonicalSnapshot().nodes.find((candidate) => candidate.id === nodeId);
  if (!node?.spans.length) throw new Error(`missing text spans for ${nodeId}`);
  const tapes = canonicalWriterAccess(document).state.getMap<Y.Text>('tapes');
  type Item = {
    id: { client: number; clock: number };
    length: number;
    deleted: boolean;
    content: unknown;
    right: Item | null;
  };
  const ids: string[] = [];
  for (const span of node.spans) {
    const tape = tapes.get(span.tapeId);
    if (!tape) throw new Error(`missing tape ${span.tapeId}`);
    let item = (tape as unknown as { _start: Item | null })._start;
    let inside = false;
    while (item) {
      const content = item.content;
      const boundary =
        content && typeof content === 'object' && 'embed' in content
          ? (content as { embed?: { grainBoundary?: string } }).embed?.grainBoundary
          : undefined;
      if (boundary === span.startBoundaryId) inside = true;
      else if (boundary === span.endBoundaryId) break;
      else if (inside && !item.deleted) {
        const text =
          content && typeof content === 'object' && 'str' in content
            ? (content as { str: string }).str
            : undefined;
        if (typeof text === 'string') {
          for (let offset = 0; offset < text.length; offset++) {
            ids.push(`${item.id.client}:${item.id.clock + offset}`);
          }
        }
      }
      item = item.right;
    }
  }
  return ids;
}

describe('canonical parser promotion', () => {
  it('orders inserted first-block text before a retained native transfer boundary', () => {
    const source = '- first\n\nsecond';
    const document = documentFor('second', 'explicit-insert-native-transfer');
    const writer = new CanonicalWriter(document);
    const sourceId = document.root.children[0]!.sharedId;
    const originalBodyIds = visibleCharacterIds(document, sourceId);

    try {
      const result = writer.edit({ actionId: 'insert-and-promote', sessionId: 'A' }, (draft) => {
        draft.spliceText(sourceId, { from: 0, to: 0, insert: '- first\n\n' });
        const current = draft.node(sourceId).content!;
        const parsed = parseBlocks(current, { provenance: true });
        expect(
          applyParserConversion(
            draft,
            document.root.sharedId,
            sourceId,
            current,
            parsed.provenance,
          ),
        ).toBe(true);
      });

      expect('receipt' in result, JSON.stringify(result)).toBe(true);
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
      const second = descendants(document.root).find(
        (node) => node.type === 'paragraph' && node.content === 'second',
      )!;
      expect(visibleCharacterIds(document, second.sharedId)).toEqual(originalBodyIds);
      expect(document.validate()).toEqual({ valid: true, errors: [] });

      expect(writer.undo('A').status).toBe('applied');
      expect(document.root.children[0]).toMatchObject({
        sharedId: sourceId,
        type: 'paragraph',
        content: 'second',
      });
      expect(visibleCharacterIds(document, sourceId)).toEqual(originalBodyIds);
      expect(writer.redo('A').status).toBe('applied');
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    } finally {
      writer.close();
      document.close();
    }
  });

  it.each([
    ['heading', '# first\n\n'],
    ['list', '- first\n\n'],
  ] as const)(
    'keeps a replacement before the retained second block during %s promotion',
    (kind, prefix) => {
      const original = 'oldsecond';
      const source = `${prefix}second`;
      const document = documentFor(original, `replacement-${kind}-promotion`);
      const writer = new CanonicalWriter(document);
      const sourceId = document.root.children[0]!.sharedId;
      const originalIds = visibleCharacterIds(document, sourceId);
      const retainedBodyIds = originalIds.slice('old'.length);

      try {
        const result = writer.edit(
          { actionId: `replace-and-promote-${kind}`, sessionId: 'A' },
          (draft) => {
            draft.spliceText(sourceId, { from: 0, to: 3, insert: prefix });
            const current = draft.node(sourceId).content!;
            const parsed = parseBlocks(current, { provenance: true });
            expect(
              applyParserConversion(
                draft,
                document.root.sharedId,
                sourceId,
                current,
                parsed.provenance,
              ),
            ).toBe(true);
          },
        );

        expect('receipt' in result, JSON.stringify(result)).toBe(true);
        expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
        const second = descendants(document.root).find(
          (node) => node.type === 'paragraph' && node.content === 'second',
        )!;
        expect(visibleCharacterIds(document, second.sharedId)).toEqual(retainedBodyIds);
        expect(document.validate()).toEqual({ valid: true, errors: [] });

        expect(writer.undo('A').status).toBe('applied');
        expect(document.root.children[0]).toMatchObject({
          sharedId: sourceId,
          type: 'paragraph',
          content: original,
        });
        expect(visibleCharacterIds(document, sourceId).slice(-retainedBodyIds.length)).toEqual(
          retainedBodyIds,
        );
        expect(writer.redo('A').status).toBe('applied');
        expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
        const redoneSecond = descendants(document.root).find(
          (node) => node.type === 'paragraph' && node.content === 'second',
        )!;
        expect(visibleCharacterIds(document, redoneSecond.sharedId)).toEqual(retainedBodyIds);
        expect(document.validate()).toEqual({ valid: true, errors: [] });
      } finally {
        writer.close();
        document.close();
      }
    },
  );

  it('splices retained text between action-local pieces in a seeded output tape', () => {
    const source = '# first\n\n before original after';
    const document = documentFor('original', 'inserted-around-retained-output');
    const writer = new CanonicalWriter(document);
    const sourceId = document.root.children[0]!.sharedId;
    const originalBodyIds = visibleCharacterIds(document, sourceId);
    const prefix = '# first\n\n before ';
    const suffix = ' after';

    try {
      const result = writer.edit({ actionId: 'wrap-native-output', sessionId: 'A' }, (draft) => {
        draft.spliceText(sourceId, { from: 0, to: 0, insert: prefix });
        const beforeSuffix = draft.node(sourceId).content!;
        draft.spliceText(sourceId, {
          from: beforeSuffix.length,
          to: beforeSuffix.length,
          insert: suffix,
        });
        const current = draft.node(sourceId).content!;
        const parsed = parseBlocks(current, { provenance: true });
        expect(
          applyParserConversion(
            draft,
            document.root.sharedId,
            sourceId,
            current,
            parsed.provenance,
          ),
        ).toBe(true);
      });

      expect('receipt' in result, JSON.stringify(result)).toBe(true);
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
      const paragraph = descendants(document.root).find(
        (node) => node.type === 'paragraph' && node.content === ' before original after',
      )!;
      expect(
        visibleCharacterIds(document, paragraph.sharedId).slice(
          ' before '.length,
          ' before '.length + originalBodyIds.length,
        ),
      ).toEqual(originalBodyIds);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
      expect(writer.undo('A').status).toBe('applied');
      expect(document.root.children[0]).toMatchObject({
        sharedId: sourceId,
        type: 'paragraph',
        content: 'original',
      });
      expect(writer.redo('A').status).toBe('applied');
      expect(document.exportMarkdownTree()).toEqual(parseBlocks(source).node);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    } finally {
      writer.close();
      document.close();
    }
  });

  it('keeps the triggering input, consumed marker and heading promotion in one undo group', () => {
    const document = documentFor('#abc', 'heading-undo');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const originalId = paragraph.sharedId;
    const retainedBodyIds = visibleCharacterIds(document, originalId).slice(1);

    accept(
      writer,
      writer.prepareTextInput(
        originalId,
        { from: 1, to: 1, insert: ' ' },
        { actionId: 'type-heading-space', sessionId: 'A', historyGroupId: 'heading-promotion' },
      ),
    );

    expect(document.root.children).toHaveLength(1);
    expect(document.root.children[0]).toMatchObject({
      sharedId: originalId,
      type: 'section',
      marker: '#',
      content: 'abc',
    });
    expect(visibleCharacterIds(document, originalId)).toEqual(retainedBodyIds);
    expect(document.validate()).toEqual({ valid: true, errors: [] });

    expect(writer.undo('A').status).toBe('applied');
    expect(document.root.children[0]).toMatchObject({
      sharedId: originalId,
      type: 'paragraph',
      content: '#abc',
    });
    expect(document.validate()).toEqual({ valid: true, errors: [] });

    expect(writer.redo('A').status).toBe('applied');
    expect(document.root.children[0]).toMatchObject({
      sharedId: originalId,
      type: 'section',
      marker: '#',
      content: 'abc',
    });
    writer.close();
    document.close();
  });

  it('imports the completed provenance tree once without hidden construction history', () => {
    const source = '# Heading\n\n> - [x] body\n>   continuation\n';
    const parsed = parseBlocks(source, { provenance: true });
    const document = documentFor(source, 'single-import');
    const writer = new CanonicalWriter(document);
    const beforeReads = document.checkpoint().update;

    expect(document.exportMarkdownTree()).toEqual(parsed.provenance.output);
    expect(document.canonicalSnapshot().tapes).toHaveLength(
      Object.keys(parsed.provenance.inlinePieces).length,
    );
    expect(document.canonicalSnapshot().tapes.every((tape) => tape.revision === 0)).toBe(true);
    expect(writer.canUndo()).toBe(false);
    expect(document.checkpoint().update).toEqual(beforeReads);
    writer.close();
    document.close();
  });

  it('transfers multiline quote content with multiple retained ranges', () => {
    const document = documentFor('', 'multiline-quote-promotion');
    const writer = new CanonicalWriter(document);
    const sourceId = document.root.children[0]!.sharedId;
    accept(
      writer,
      writer.prepareTextInput(
        sourceId,
        { from: 0, to: 0, insert: '# heading\n> body\n> continuation' },
        { actionId: 'promote-multiline-quote', sessionId: 'A' },
      ),
    );

    expect(document.node(sourceId)).toMatchObject({ type: 'section', content: 'heading' });
    expect(
      descendants(document.root).some(
        (node) => node.type === 'paragraph' && node.content === 'body\ncontinuation',
      ),
    ).toBe(true);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('retains remote body typing when undo reverses a promotion', () => {
    const document = documentFor('#abc', 'remote-body');
    const writer = new CanonicalWriter(document);
    const originalId = document.root.children[0]!.sharedId;
    accept(
      writer,
      writer.prepareTextInput(
        originalId,
        { from: 1, to: 1, insert: ' ' },
        { actionId: 'promote-heading', sessionId: 'A', historyGroupId: 'heading-promotion' },
      ),
    );
    accept(
      writer,
      writer.prepareTextInput(
        originalId,
        { from: 3, to: 3, insert: '!' },
        { actionId: 'remote-body-edit', sessionId: 'B', historyGroupId: 'remote-body' },
      ),
      'B',
    );

    expect(document.node(originalId).content).toBe('abc!');
    expect(writer.undo('A').status).toBe('applied');
    expect(document.root.children[0]).toMatchObject({
      sharedId: originalId,
      type: 'paragraph',
      content: '#abc!',
    });
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('uses deterministic node identities when replicas accept the same parser plan', () => {
    const document = documentFor('body', 'deterministic-id');
    const replica = CanonicalDocument.open(document.checkpoint());
    const writer = new CanonicalWriter(document);
    const replicaWriter = new CanonicalWriter(replica);
    const originalId = document.root.children[0]!.sharedId;
    const request = writer.prepareTextInput(
      originalId,
      { from: 0, to: 0, insert: '- [x] ' },
      { actionId: 'replicated-list-promotion', sessionId: 'A' },
    );

    accept(writer, request);
    accept(replicaWriter, request);

    expect(replica.canonicalSnapshot()).toEqual(document.canonicalSnapshot());
    expect(replica.exportMarkdownTree()).toEqual(document.exportMarkdownTree());
    writer.close();
    replicaWriter.close();
    document.close();
    replica.close();
  });

  it.each([
    {
      name: 'task list',
      source: 'body',
      edit: { from: 0, to: 0, insert: '- [x] ' },
      ancestry: ['document', 'list', 'list-item', 'paragraph'],
      checked: true,
    },
    {
      name: 'nested quote and list',
      source: 'body',
      edit: { from: 0, to: 0, insert: '> - [ ] ' },
      ancestry: ['document', 'block-quote', 'list', 'list-item', 'paragraph'],
      checked: false,
    },
    {
      name: 'setext heading',
      source: 'Title',
      edit: { from: 5, to: 5, insert: '\n===' },
      ancestry: ['document', 'section'],
      marker: '#',
    },
    {
      name: 'fenced code block',
      source: 'body',
      edit: { from: 0, to: 0, insert: '```ts\n' },
      ancestry: ['document', 'code-block'],
      info: 'ts',
    },
  ])(
    'uses parser provenance for $name',
    ({ name, source, edit, ancestry, checked, marker, info }) => {
      const document = documentFor(source, name.replaceAll(' ', '-'));
      const writer = new CanonicalWriter(document);
      const originalId = document.root.children[0]!.sharedId;
      accept(
        writer,
        writer.prepareTextInput(originalId, edit, {
          actionId: `promote-${name.replaceAll(' ', '-')}`,
          sessionId: 'A',
        }),
      );

      const node = document.node(originalId);
      expect(node.content).toBe(name === 'setext heading' ? 'Title' : 'body');
      expect(
        descendants(document.root).find((candidate) => candidate.sharedId === originalId),
      ).toBe(node);
      const path: string[] = [];
      let current: CanonicalNode | undefined = node;
      while (current) {
        path.unshift(current.type);
        current = current.parent;
      }
      expect(path).toEqual(ancestry);
      if (checked !== undefined) {
        expect(node.parent?.type).toBe('list-item');
        expect(node.parent?.checked).toBe(checked);
      }
      if (marker !== undefined) expect(node.marker).toBe(marker);
      if (info !== undefined) expect(node.info).toBe(info);
      expect(document.validate()).toEqual({ valid: true, errors: [] });

      expect(writer.undo('A').status).toBe('applied');
      expect(document.root.children[0]).toMatchObject({
        sharedId: originalId,
        type: 'paragraph',
        content: source,
      });
      expect(document.validate()).toEqual({ valid: true, errors: [] });
      writer.close();
      document.close();
    },
  );

  it('skips automatic promotion after the target kind token changes', () => {
    const document = documentFor('#abc', 'stale-kind');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const request = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 1, to: 1, insert: ' ' },
      { actionId: 'stale-promotion', sessionId: 'A' },
    );
    writer.edit({ actionId: 'change-target-kind' }, (draft) => {
      draft.convertInline(paragraph.sharedId, {
        type: 'section',
        marker: '#',
        content: { mode: 'preserve' },
      });
    });

    const result = writer.apply(request, context(request));
    expect(result.status).toBe('pending');
    if (result.status !== 'pending')
      throw new Error(`expected pending action, got ${result.status}`);
    expect(result.pending.receipt.promotionSkipped).toBe('ownershipChanged');
    writer.publish(result.pending);
    expect(paragraph.type).toBe('section');
    expect(paragraph.content).toBe('# abc');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('skips automatic promotion after the target span ownership changes', () => {
    const document = documentFor('#abc', 'stale-spans');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const request = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 1, to: 1, insert: ' ' },
      { actionId: 'stale-span-promotion', sessionId: 'A' },
    );
    writer.edit({ actionId: 'move-marker-out', sessionId: 'B' }, (draft) => {
      const marker = draft.create({ type: 'paragraph', content: '' });
      draft.place(marker, document.root.sharedId, null);
      draft.transferInlineRange({
        source: paragraph.sharedId,
        from: 0,
        to: 1,
        destination: marker,
        at: 0,
        affinity: 'right',
      });
    });

    const result = writer.apply(request, context(request));
    expect(result.status).toBe('pending');
    if (result.status !== 'pending')
      throw new Error(`expected pending action, got ${result.status}`);
    expect(result.pending.receipt.promotionSkipped).toBe('ownershipChanged');
    writer.publish(result.pending);
    expect(paragraph.type).toBe('paragraph');
    expect(paragraph.content).toContain('abc');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('rejects a stale explicit conversion without a partial write', () => {
    const document = documentFor('#abc', 'explicit-rejection');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const explicit = writer.prepareCommand(
      { actionId: 'explicit-conversion', sessionId: 'A' },
      (draft) => {
        draft.convertInline(paragraph.sharedId, {
          type: 'section',
          marker: '#',
          content: { mode: 'preserve' },
        });
      },
    );
    writer.edit({ actionId: 'edit-after-explicit-prepare', sessionId: 'B' }, (draft) => {
      draft.spliceText(paragraph.sharedId, { from: 4, to: 4, insert: '!' });
    });
    const before = document.checkpoint().update;

    expect(writer.apply(explicit, context(explicit))).toEqual({
      status: 'rejected',
      reason: 'stale-precondition',
    });
    expect(document.checkpoint().update).toEqual(before);
    expect(paragraph).toMatchObject({ type: 'paragraph', content: '#abc!' });
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });
});
