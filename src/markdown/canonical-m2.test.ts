import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import { canonicalWriterAccess, CanonicalDocument } from './canonical-model.js';
import { resolveCanonicalTextAnchor } from './canonical-selection.js';
import type { ActionRequest, AdmittedContext, Bookmark } from './canonical-actions.js';
import type { Span } from './canonical-model.js';

interface NativeItem {
  readonly id: { readonly client: number; readonly clock: number };
  readonly right: NativeItem | null;
  readonly deleted: boolean;
  readonly content: unknown;
}

function nativeBoundaryItems(tape: Y.Text): readonly string[] {
  const result: string[] = [];
  let item = (tape as unknown as { readonly _start: NativeItem | null })._start;
  while (item) {
    const embed =
      item.content && typeof item.content === 'object' && 'embed' in item.content
        ? (item.content as { readonly embed: unknown }).embed
        : undefined;
    const boundaryId =
      embed && typeof embed === 'object' && 'grainBoundary' in embed
        ? (embed as { readonly grainBoundary: unknown }).grainBoundary
        : undefined;
    if (!item.deleted && typeof boundaryId === 'string') {
      result.push(`${boundaryId}@${item.id.client}:${item.id.clock}`);
    }
    item = item.right;
  }
  return result;
}

function context(request: ActionRequest): AdmittedContext {
  return {
    sessionId: request.sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  };
}

function accept(writer: CanonicalWriter, request: ActionRequest) {
  writer.admitSession(request.sessionId);
  const result = writer.apply(request, context(request));
  expect(result.status).toBe('pending');
  if (result.status !== 'pending') throw new Error(`expected pending commit, got ${result.status}`);
  return writer.publish(result.pending);
}

function makeDocument(markdown: string) {
  return CanonicalDocument.fromMarkdown(markdown, {
    documentId: `m2-${markdown.length}`,
    authorityEpoch: 'm2-epoch',
    actionId: `m2-import-${markdown.length}`,
  });
}

describe('Yjs M2 incremental input', () => {
  it('reuses its author and validation replicas without full-state export or registry walks', () => {
    const markdown = Array.from({ length: 80 }, (_, index) => `paragraph ${index}`).join('\n\n');
    const document = makeDocument(markdown);
    const writer = new CanonicalWriter(document);
    try {
      const target = document.root.children[40]!;
      accept(
        writer,
        writer.prepareTextInput(
          target.sharedId,
          { from: target.content!.length, to: target.content!.length, insert: '!' },
          { actionId: 'm2-author-initialize', sessionId: 'steady-author' },
        ),
      );

      const state = canonicalWriterAccess(document).state;
      const nodeMap = state.getMap('nodes');
      const tapeMap = state.getMap<Y.Text>('tapes');
      const tapeId = document.canonicalSnapshot().nodes.find((node) => node.id === target.sharedId)!
        .spans[0]!.tapeId;
      const tape = tapeMap.get(tapeId);
      const markersBefore = nativeBoundaryItems(tape!);
      const nodeEntries = vi.spyOn(nodeMap, 'entries');
      const tapeEntries = vi.spyOn(tapeMap, 'entries');
      const beforeReuse = writer.operationCounts;

      accept(
        writer,
        writer.prepareTextInput(
          target.sharedId,
          { from: target.content!.length, to: target.content!.length, insert: '?' },
          { actionId: 'm2-author-reuse', sessionId: 'steady-author' },
        ),
      );

      expect(writer.operationCounts).toEqual({
        ...beforeReuse,
        literalTextInputs: beforeReuse.literalTextInputs + 1,
      });
      expect(nodeEntries).not.toHaveBeenCalled();
      expect(tapeEntries).not.toHaveBeenCalled();
      expect(target.content).toBe('paragraph 40!?');
      expect(tape).toBe(tapeMap.get(tapeId));
      expect(nativeBoundaryItems(tape!)).toEqual(markersBefore);
      nodeEntries.mockRestore();
      tapeEntries.mockRestore();
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    } finally {
      writer.close();
      document.close();
    }
  });

  it('refreshes persistent input replicas after an externally accepted text edit', () => {
    const document = makeDocument('seed');
    const writer = new CanonicalWriter(document);
    const target = document.root.children[0]!;
    try {
      accept(
        writer,
        writer.prepareTextInput(
          target.sharedId,
          { from: target.content!.length, to: target.content!.length, insert: '!' },
          { actionId: 'm2-before-external-update', sessionId: 'steady-author' },
        ),
      );

      const replica = CanonicalDocument.open(document.checkpoint());
      const remoteWriter = new CanonicalWriter(replica);
      try {
        const remote = remoteWriter.edit(
          { actionId: 'm2-external-update', sessionId: 'remote' },
          (draft) => draft.spliceText(target.sharedId, { from: 0, to: 0, insert: 'R' }),
        );
        if (!('receipt' in remote)) throw new Error(`expected remote commit, got ${remote.status}`);
        document.applyAccepted({ revision: remote.revision, update: remote.update });
      } finally {
        remoteWriter.close();
        replica.close();
      }

      const beforeReuse = writer.operationCounts;
      const content = target.content!;
      accept(
        writer,
        writer.prepareTextInput(
          target.sharedId,
          { from: content.length, to: content.length, insert: '?' },
          { actionId: 'm2-after-external-update', sessionId: 'steady-author' },
        ),
      );

      expect(target.content).toBe('Rseed!?');
      expect(writer.operationCounts).toEqual({
        ...beforeReuse,
        literalTextInputs: beforeReuse.literalTextInputs + 1,
      });
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    } finally {
      writer.close();
      document.close();
    }
  });

  it.each(['replace-marker', 'before-sentinel', 'after-sentinel'] as const)(
    'rejects %s before publication and rebuilds a contaminated replica on retry',
    (mutation) => {
      const document = makeDocument('seed');
      const writer = new CanonicalWriter(document);
      writer.admitSession('remote-author');
      try {
        const target = document.root.children[0]!;
        const valid = writer.prepareTextInput(
          target.sharedId,
          { from: 4, to: 4, insert: '!' },
          { actionId: 'm2-rejected-author', sessionId: 'remote-author' },
        );
        const replica = new Y.Doc({ gc: false });
        Y.applyUpdate(replica, document.checkpoint().update);
        const beforeMutation = Y.encodeStateVector(replica);
        const node = replica.getMap<Y.Map<unknown>>('nodes').get(target.sharedId)!;
        const spanCell = node.get('spans') as { readonly value: readonly Span[] };
        const span = spanCell.value[0]!;
        const tape = replica.getMap<Y.Text>('tapes').get(span.tapeId)!;
        if (mutation === 'replace-marker') {
          const marker = tape.toDelta()[0]!.insert;
          tape.delete(0, 1);
          tape.insertEmbed(0, marker);
        } else if (mutation === 'before-sentinel') tape.insert(0, 'outside');
        else tape.insert(tape.length, 'outside');
        const invalidBoundaryUpdate = Y.encodeStateAsUpdate(replica, beforeMutation);
        const before = document.checkpoint().update;
        const beforeRejectedCounts = writer.operationCounts;

        const rejected = writer.apply(
          { ...valid, textUpdate: Y.mergeUpdates([valid.textUpdate!, invalidBoundaryUpdate]) },
          context(valid),
        );
        expect(rejected).toEqual({ status: 'rejected', reason: 'invalid-text-update' });
        expect(document.checkpoint().update).toEqual(before);
        expect(target.content).toBe('seed');
        replica.destroy();

        const retry = writer.prepareTextInput(
          target.sharedId,
          { from: 4, to: 4, insert: '?' },
          { actionId: 'm2-valid-after-rejection', sessionId: 'remote-author' },
        );
        accept(writer, retry);
        expect(target.content).toBe('seed?');
        expect(writer.operationCounts).toMatchObject({
          authorReplicaCreations: beforeRejectedCounts.authorReplicaCreations + 1,
          validationReplicaCreations: beforeRejectedCounts.validationReplicaCreations + 1,
        });
        expect(document.validate()).toEqual({ valid: true, errors: [] });
      } finally {
        writer.close();
        document.close();
      }
    },
  );

  it.each(
    [false, true].flatMap((promotion) =>
      (['unknown-node', 'span-index'] as const).flatMap((invalid) =>
        (['A', 'B'] as const).map((retrySession) => ({ promotion, invalid, retrySession })),
      ),
    ),
  )(
    'cleans up $invalid focus after $promotion input before retrying as $retrySession',
    ({ promotion, invalid, retrySession }) => {
      const document = makeDocument('seed');
      const writer = new CanonicalWriter(document);
      writer.admitSession('A');
      writer.admitSession('B');
      const target = document.root.children[0]!;
      try {
        const before = document.checkpoint().update;
        const bookmark: Bookmark = {
          nodeId: invalid === 'unknown-node' ? 'missing-node' : target.sharedId,
          offset: 0,
          affinity: 'right',
          ...(invalid === 'span-index' ? { spanIndex: 99 } : {}),
        };
        const badRequest = writer.prepareTextInput(
          target.sharedId,
          promotion ? { from: 0, to: 0, insert: '# ' } : { from: 4, to: 4, insert: '!' },
          {
            actionId: `bad-${promotion}-${invalid}`,
            sessionId: 'A',
            focus: { start: bookmark },
          },
        );

        const rejected = writer.apply(badRequest, context(badRequest));
        expect(rejected).toEqual({ status: 'rejected', reason: 'invalid-operation' });
        expect(document.checkpoint().update).toEqual(before);
        expect(writer.poisonedWriter).toBe(false);
        expect(writer.canUndo('A', document.root.sharedId)).toBe(false);
        expect(writer.canUndo('B', document.root.sharedId)).toBe(false);

        const retry = writer.prepareTextInput(
          target.sharedId,
          { from: 4, to: 4, insert: '?' },
          { actionId: `clean-${retrySession}-${promotion}-${invalid}`, sessionId: retrySession },
        );
        accept(writer, retry);
        expect(target.content).toBe('seed?');
        expect(writer.canUndo('A', document.root.sharedId)).toBe(retrySession === 'A');
        expect(writer.canUndo('B', document.root.sharedId)).toBe(retrySession === 'B');
        expect(document.validate()).toEqual({ valid: true, errors: [] });
      } finally {
        writer.close();
        document.close();
      }
    },
  );

  it.each([
    ['space', ' '],
    ['tab', '\t'],
    ['nonbreaking space', '\u00a0'],
    ['vertical tab', '\u000b'],
    ['form feed', '\u000c'],
  ])('promotes ATX input with %s whitespace and preserves its history', (_name, whitespace) => {
    const document = makeDocument('Heading');
    const writer = new CanonicalWriter(document);
    const target = document.root.children[0]!;
    try {
      const request = writer.prepareTextInput(
        target.sharedId,
        { from: 0, to: 0, insert: `#${whitespace}` },
        { actionId: `heading-${_name}`, sessionId: 'A' },
      );
      accept(writer, request);

      expect(document.root.children[0]!.type).toBe('section');
      expect(document.root.children[0]!.content).toBe('Heading');
      expect(writer.undo('A').status).toBe('applied');
      expect(document.root.children[0]!.type).toBe('paragraph');
      expect(writer.redo('A').status).toBe('applied');
      expect(document.root.children[0]!.type).toBe('section');
      expect(document.root.children[0]!.content).toBe('Heading');
    } finally {
      writer.close();
      document.close();
    }
  });

  it.each(
    [
      {
        structure: 'root siblings',
        markdown: 'alpha\n\nbeta\n\ngamma',
        before: ['alpha', 'beta', 'gamma'],
        after: ['alpha', 'gamma'],
      },
      {
        structure: 'nested section siblings',
        markdown: '# parent\n\n## alpha\n\n## beta\n\n## gamma',
        before: ['parent', 'alpha', 'beta', 'gamma'],
        after: ['parent', 'alpha', 'gamma'],
      },
    ].flatMap((fixture) => (['literal', 'command'] as const).map((mode) => ({ ...fixture, mode }))),
  )(
    'resolves $mode history focus in $structure after another session detaches the focused inline',
    ({ mode, markdown, before, after }) => {
      const document = makeDocument(markdown);
      const writer = new CanonicalWriter(document);
      const findByContent = (
        node: typeof document.root,
        content: string,
      ): typeof document.root | undefined => {
        if (node.content === content) return node;
        for (const child of node.children) {
          const match = findByContent(child, content);
          if (match) return match;
        }
        return undefined;
      };
      const visibleContents = (node: typeof document.root): string[] => [
        ...(node.content === undefined ? [] : [node.content]),
        ...node.children.flatMap(visibleContents),
      ];
      const middle = findByContent(document.root, 'beta')!;
      const last = findByContent(document.root, 'gamma')!;
      writer.admitSession('A');
      try {
        expect(visibleContents(document.root)).toEqual(before);
        const focus = {
          start: { nodeId: middle.sharedId, offset: 2, affinity: 'right' as const },
          end: { nodeId: middle.sharedId, offset: 3, affinity: 'right' as const },
        };
        if (mode === 'literal') {
          accept(
            writer,
            writer.prepareTextInput(
              middle.sharedId,
              { from: 2, to: 2, insert: '!' },
              { actionId: 'type', sessionId: 'A', focus },
            ),
          );
        } else {
          const typed = writer.edit({ actionId: 'type', sessionId: 'A' }, (draft) => {
            draft.spliceText(middle.sharedId, { from: 2, to: 2, insert: '!' });
            return focus;
          });
          expect('receipt' in typed).toBe(true);
        }

        const detached = writer.edit({ actionId: 'detach', sessionId: 'B' }, (draft) =>
          draft.detach(middle.sharedId),
        );
        expect('receipt' in detached).toBe(true);
        expect(visibleContents(document.root)).toEqual(after);

        const undone = writer.undo('A');
        expect(undone.status).toBe('applied');
        expect(undone.focusAnchor).toBeDefined();
        expect(resolveCanonicalTextAnchor(document, undone.focusAnchor!)).toMatchObject({
          nodeId: last.sharedId,
          offset: 2,
        });

        const redone = writer.redo('A');
        expect(redone.status).toBe('applied');
        expect(redone.focusAnchor).toBeDefined();
        expect(resolveCanonicalTextAnchor(document, redone.focusAnchor!)).toMatchObject({
          nodeId: last.sharedId,
          offset: 3,
        });
      } finally {
        writer.close();
        document.close();
      }
    },
  );

  it.each([10, 150, 1000].flatMap((size) => [false, true].map((focus) => ({ size, focus }))))(
    'keeps literal input work local at $size paragraphs with focus=$focus',
    ({ size, focus }) => {
      const markdown = Array.from({ length: size }, (_, index) => `paragraph ${index}`).join(
        '\n\n',
      );
      const document = makeDocument(markdown);
      const writer = new CanonicalWriter(document);
      const target = document.root.children[0]!;
      try {
        accept(
          writer,
          writer.prepareTextInput(
            target.sharedId,
            { from: 0, to: 0, insert: 'a' },
            { actionId: 'locality-warmup', sessionId: 'steady-author' },
          ),
        );

        const state = canonicalWriterAccess(document).state;
        const nodes = state.getMap('nodes');
        const tapes = state.getMap('tapes');
        const nodeGets = vi.spyOn(nodes, 'get');
        const tapeEntries = vi.spyOn(tapes, 'entries');
        const imports = vi.spyOn(CanonicalDocument, 'fromParsed');
        const countsBefore = writer.operationCounts;
        const request = writer.prepareTextInput(
          target.sharedId,
          { from: 0, to: 0, insert: 'b' },
          {
            actionId: 'locality-literal',
            sessionId: 'steady-author',
            ...(focus
              ? {
                  focus: {
                    start: { nodeId: target.sharedId, offset: 0, affinity: 'right' as const },
                    end: { nodeId: target.sharedId, offset: 1, affinity: 'right' as const },
                  },
                }
              : {}),
          },
        );
        const afterPrepareGets = nodeGets.mock.calls.length;
        const result = writer.apply(request, context(request));
        expect(result.status).toBe('pending');
        if (result.status !== 'pending') throw new Error('expected pending commit');
        const afterApplyGets = nodeGets.mock.calls.length;
        writer.publish(result.pending);
        const afterPublishGets = nodeGets.mock.calls.length;

        expect(imports).not.toHaveBeenCalled();
        expect(tapeEntries).not.toHaveBeenCalled();
        expect(afterPrepareGets).toBe(2);
        expect(afterApplyGets - afterPrepareGets).toBe(focus ? 4 : 3);
        expect(afterPublishGets - afterApplyGets).toBe(0);
        expect(writer.operationCounts).toEqual({
          ...countsBefore,
          literalTextInputs: countsBefore.literalTextInputs + 1,
        });
        expect(document.validate()).toEqual({ valid: true, errors: [] });
        nodeGets.mockRestore();
        tapeEntries.mockRestore();
        imports.mockRestore();
      } finally {
        vi.restoreAllMocks();
        writer.close();
        document.close();
      }
    },
  );
});
