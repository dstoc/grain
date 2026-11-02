import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import corpusText from '../../benchmarks/yjs-m0/parity-corpus.json?raw';
import {
  CanonicalDocument,
  canonicalWriterAccess,
  tapeItemSignature,
  type CanonicalNode,
} from './canonical-model.js';
import { CanonicalWriter, type ActionRequest } from './canonical-actions.js';
import { serializeToString } from './block-serializer.js';
import { measureNativeOperations, snapshotNativeState } from '../../benchmarks/yjs-m0/counters.js';

interface ParityFixture {
  readonly id: string;
  readonly markdown: string;
  readonly targetContent: string;
  readonly edit: { readonly from: number; readonly to: number; readonly insert: string };
  readonly expectedContent: string;
  readonly expectedMarkdown: string;
}

interface ParityCorpus {
  readonly visibleBehaviorFixtures: readonly ParityFixture[];
  readonly intentionalDifferences: readonly {
    readonly id: string;
    readonly classification: string;
    readonly rationale: string;
  }[];
  readonly protectedSuites: readonly string[];
}

const corpus = JSON.parse(corpusText) as ParityCorpus;

function findNodesByContent(document: CanonicalDocument, content: string): CanonicalNode[] {
  const found: CanonicalNode[] = [];
  const visit = (node: CanonicalNode) => {
    if (node.content === content) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(document.root);
  return found;
}

function makeDocument(markdown: string, fixtureId: string): CanonicalDocument {
  return CanonicalDocument.fromMarkdown(markdown, {
    documentId: `m0-parity-${fixtureId}`,
    authorityEpoch: 'm0-parity-epoch',
    actionId: `m0-parity-import-${fixtureId}`,
    makeId: (role, ordinal) => `m0-${fixtureId}-${role}-${ordinal}`,
  });
}

function admitted(request: ActionRequest) {
  return {
    sessionId: request.sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  };
}

describe('M0 canonical parity corpus', () => {
  for (const fixture of corpus.visibleBehaviorFixtures) {
    it(`${fixture.id}: preserves visible Markdown behavior through accepted input and reconstruction`, () => {
      const document = makeDocument(fixture.markdown, fixture.id);
      const writer = new CanonicalWriter(document);
      const [target] = findNodesByContent(document, fixture.targetContent);
      expect(target, `fixture target ${fixture.targetContent}`).toBeDefined();
      expect(findNodesByContent(document, fixture.targetContent)).toHaveLength(1);

      const request = writer.prepareTextInput(target!.sharedId, fixture.edit, {
        actionId: `m0-parity-edit-${fixture.id}`,
        sessionId: 'm0-parity-session',
      });
      writer.admitSession('m0-parity-session');
      const applied = writer.apply(request, admitted(request));
      expect(applied.status).toBe('pending');
      if (applied.status !== 'pending')
        throw new Error(`fixture action rejected: ${applied.status}`);
      writer.publish(applied.pending);

      expect(target!.content).toBe(fixture.expectedContent);
      expect(serializeToString(document.exportMarkdownTree())).toBe(fixture.expectedMarkdown);
      expect(document.validate()).toEqual({ valid: true, errors: [] });

      const reconstructed = CanonicalDocument.open(document.checkpoint());
      try {
        expect(serializeToString(reconstructed.exportMarkdownTree())).toBe(
          fixture.expectedMarkdown,
        );
        expect(reconstructed.validate()).toEqual({ valid: true, errors: [] });
      } finally {
        reconstructed.close();
      }
      writer.close();
      document.close();
    });
  }

  it('preserves canonical identity across checkpoint reconstruction as an intentional legacy difference', () => {
    const fixture = corpus.intentionalDifferences.find(
      (item) => item.id === 'canonical-checkpoint-identity',
    );
    expect(fixture?.classification).toBe('intentional-difference');
    expect(fixture?.rationale).toContain('outside visible Markdown parity');

    const document = makeDocument('# Topic\n\nalpha\n\n- one\n- two', fixture!.id);
    const before = document.canonicalSnapshot();
    const state = canonicalWriterAccess(document).state;
    const tapeSignatures = before.tapes.map((tape) => [
      tape.id,
      tapeItemSignature(state.getText(tape.id)),
    ]);
    const reconstructed = CanonicalDocument.open(document.checkpoint());
    try {
      const reconstructedState = canonicalWriterAccess(reconstructed).state;
      expect(reconstructed.canonicalSnapshot()).toEqual(before);
      expect(
        reconstructed
          .canonicalSnapshot()
          .tapes.map((tape) => [tape.id, tapeItemSignature(reconstructedState.getText(tape.id))]),
      ).toEqual(tapeSignatures);
      expect(serializeToString(reconstructed.exportMarkdownTree())).toBe(
        serializeToString(document.exportMarkdownTree()),
      );
    } finally {
      reconstructed.close();
      document.close();
    }
  });

  it('keeps the collaboration and reconstruction suites in the normal CI corpus', () => {
    expect(corpus.protectedSuites).toContain('src/markdown/canonical-collaboration.test.ts');
    expect(corpus.protectedSuites).toContain('src/markdown/canonical-model.test.ts');
    expect(corpus.protectedSuites).toContain('src/editing/canonical-editor.browser.test.ts');
    expect(corpus.protectedSuites).toHaveLength(6);
  });
});

describe('Yjs native operation counters', () => {
  it('writes only the changed tape revision in the M1 action path', () => {
    const document = makeDocument('alpha\n\nbeta\n\ngamma', 'revision-write-counter');
    const writer = new CanonicalWriter(document);
    const initial = snapshotNativeState(document);
    expect(initial.ownership.distinctOwnerNodeCount).toBeGreaterThan(0);
    expect(
      initial.ownership.byTape.every(
        ({ spanCount, ownerCount, tapeCount }) => spanCount > 0 && ownerCount > 0 && tapeCount > 0,
      ),
    ).toBe(true);
    expect(initial.ownership.byTape.reduce((count, entry) => count + entry.tapeCount, 0)).toBe(
      initial.tapeCount,
    );
    const target = document.root.children[0]!;
    const targetTapeId = document
      .canonicalSnapshot()
      .nodes.find((node) => node.id === target.sharedId)!.spans[0]!.tapeId;
    const revisions = canonicalWriterAccess(document).state.getMap<number>('tapeRevisions');
    const liveRevisionKeys: string[] = [];
    const onRevision = (event: Y.YMapEvent<number>) => {
      liveRevisionKeys.push(...event.keysChanged);
    };
    revisions.observe(onRevision);
    const measured = measureNativeOperations(document, () => {
      const request = writer.prepareTextInput(
        target.sharedId,
        { from: 2, to: 3, insert: 'X' },
        { actionId: 'm0-counter-edit', sessionId: 'm0-counter-session' },
      );
      writer.admitSession('m0-counter-session');
      const result = writer.apply(request, admitted(request));
      if (result.status !== 'pending') throw new Error(`counter action rejected: ${result.status}`);
      return writer.publish(result.pending);
    });
    const revisionAssignments = Object.entries(measured.counts.writesByPath)
      .filter(([path]) => path.startsWith('tapeRevisions:set.'))
      .reduce((count, [, writes]) => count + writes, 0);
    const unchangedRevisionAssignments = Object.entries(measured.counts.unchangedMapSetsByPath)
      .filter(([path]) => path.startsWith('tapeRevisions:set.'))
      .reduce((count, [, writes]) => count + writes, 0);
    expect(measured.value.update.byteLength).toBeGreaterThan(0);
    expect(measured.counts.textInserts).toBeGreaterThan(0);
    expect(measured.counts.updateEvents).toBeGreaterThan(0);
    expect(measured.counts.updateEventBytes).toBeGreaterThan(0);
    expect(measured.counts.publicDocTransactCalls).toBeGreaterThan(0);
    expect(revisionAssignments).toBeGreaterThanOrEqual(2);
    expect(unchangedRevisionAssignments).toBe(0);
    expect(measured.counts.unchangedMapSets).toBe(0);
    expect([...new Set(liveRevisionKeys)]).toEqual([targetTapeId]);
    expect(measured.value.receipt.touchedTapeIds).toEqual([targetTapeId]);
    revisions.unobserve(onRevision);
    writer.close();
    document.close();
  });
});
