import {describe, expect, it} from 'vitest';

import {createBlockParser, parseBlocks} from './block-parser.js';
import {serializeToString} from './block-serializer.js';
import type {DocumentNode, MarkdownNode} from './node.js';
import {MarkdownTree} from './view-model.js';

type ChainToken = 'section' | 'quote' | 'bullet' | 'ordered';
type LeafToken = 'paragraph' | 'code-block';
type SiblingKind =
  | 'paragraph'
  | 'empty-paragraph'
  | 'quote'
  | 'bullet'
  | 'ordered'
  | 'code-block';
type Augmentation =
  | {kind: 'root-block'; position: 'before' | 'after'; sibling: SiblingKind}
  | {
      kind: 'container-block';
      depth: number;
      position: 'before' | 'after';
      sibling: SiblingKind;
    }
  | {
      kind: 'list-sibling-item';
      depth: number;
      position: 'before' | 'after';
      sibling: SiblingKind;
    };

const RUN_EXTENSIVE =
  (
    globalThis as {
      process?: {env?: Record<string, string | undefined>};
    }
  ).process?.env?.MARKDOWN_EXTENSIVE_TESTS === '1';

interface GeneratedCase {
  chain: ChainToken[];
  leaf: LeafToken;
  augmentations: Augmentation[];
  expected: DocumentNode;
  markdown: string;
}

interface NamedGeneratedCase extends GeneratedCase {
  name: string;
}

function formatGeneratedCaseFailure(
  name: string,
  markdown: string,
  expected: DocumentNode,
  actual: DocumentNode,
  error: unknown,
): Error {
  return new Error(
    [
      name,
      `markdown:\n${markdown}`,
      `expected:\n${JSON.stringify(expected, null, 2)}`,
      `actual:\n${JSON.stringify(actual, null, 2)}`,
      String(error),
    ].join('\n\n'),
  );
}

function buildRoundtripDocument(
  chain: ChainToken[],
  leaf: LeafToken,
  augmentations: Augmentation[] = [],
): DocumentNode {
  const sectionDepths = new Map<number, number>();
  let sectionDepth = 0;
  for (let i = 0; i < chain.length; i++) {
    if (chain[i] === 'section') {
      sectionDepth++;
      sectionDepths.set(i, sectionDepth);
    }
  }

  let node: MarkdownNode =
    leaf === 'paragraph'
      ? {type: 'paragraph', content: chainLabel(chain)}
      : {type: 'code-block', info: 'ts', content: chainLabel(chain)};

  for (let i = chain.length - 1; i >= 0; i--) {
    const token = chain[i];
    switch (token) {
      case 'section': {
        const children = withContainerBlockAugmentations([node], augmentations, i);
        node = {
          type: 'section',
          marker: '#'.repeat(sectionDepths.get(i) ?? 1),
          content: `section ${i + 1}`,
          children,
        };
        break;
      }
      case 'quote': {
        const children = withContainerBlockAugmentations([node], augmentations, i);
        node = {
          type: 'block-quote',
          marker: '> ',
          children,
        };
        break;
      }
      case 'bullet':
      case 'ordered': {
        const itemChildren = withContainerBlockAugmentations(
          [node],
          augmentations,
          i,
        );
        const item = {
          type: 'list-item' as const,
          marker: token === 'bullet' ? '- ' : '1. ',
          checked: undefined,
          children: itemChildren,
        };
        const children = withListSiblingItemAugmentations([item], augmentations, i);
        node = {
          type: 'list',
          children,
        };
        break;
      }
    }
  }

  return {
    type: 'document',
    children: withRootBlockAugmentations([node], augmentations),
  };
}

function chainLabel(chain: ChainToken[]): string {
  return chain.length ? chain.join(' > ') : 'root';
}

function siblingParagraph(label: string): MarkdownNode {
  return {
    type: 'paragraph',
    content: label,
  };
}

function buildSiblingNode(kind: SiblingKind, label: string): MarkdownNode {
  switch (kind) {
    case 'paragraph':
      return siblingParagraph(label);
    case 'empty-paragraph':
      return {type: 'paragraph', content: ''};
    case 'quote':
      return {
        type: 'block-quote',
        marker: '> ',
        children: [siblingParagraph(label)],
      };
    case 'bullet':
      return {
        type: 'list',
        children: [
          {
            type: 'list-item',
            marker: '- ',
            checked: undefined,
            children: [siblingParagraph(label)],
          },
        ],
      };
    case 'ordered':
      return {
        type: 'list',
        children: [
          {
            type: 'list-item',
            marker: '1. ',
            checked: undefined,
            children: [siblingParagraph(label)],
          },
        ],
      };
    case 'code-block':
      return {
        type: 'code-block',
        info: 'ts',
        content: label,
      };
  }
}

function withRootBlockAugmentations(
  children: MarkdownNode[],
  augmentations: Augmentation[],
) {
  return applyBlockAugmentations(children, augmentations, (augmentation) =>
    augmentation.kind === 'root-block'
      ? buildSiblingNode(
          augmentation.sibling,
          `root ${augmentation.position} ${augmentation.sibling}`,
        )
      : undefined,
  );
}

function withContainerBlockAugmentations(
  children: MarkdownNode[],
  augmentations: Augmentation[],
  depth: number,
) {
  return applyBlockAugmentations(children, augmentations, (augmentation) =>
    augmentation.kind === 'container-block' && augmentation.depth === depth
      ? buildSiblingNode(
          augmentation.sibling,
          `container ${depth} ${augmentation.position} ${augmentation.sibling}`,
        )
      : undefined,
  );
}

function withListSiblingItemAugmentations(
  children: MarkdownNode[],
  augmentations: Augmentation[],
  depth: number,
) {
  return applyBlockAugmentations(children, augmentations, (augmentation) =>
    augmentation.kind === 'list-sibling-item' && augmentation.depth === depth
      ? {
          type: 'list-item',
          marker: '- ',
          checked: undefined,
          children: [
            buildSiblingNode(
              augmentation.sibling,
              `list ${depth} ${augmentation.position} ${augmentation.sibling}`,
            ),
          ],
        }
      : undefined,
  );
}

function applyBlockAugmentations<T extends MarkdownNode>(
  children: T[],
  augmentations: Augmentation[],
  createSibling: (augmentation: Augmentation) => T | undefined,
) {
  const before: T[] = [];
  const after: T[] = [];
  for (const augmentation of augmentations) {
    const sibling = createSibling(augmentation);
    if (!sibling) {
      continue;
    }
    if (augmentation.position === 'before') {
      before.push(sibling);
    } else {
      after.push(sibling);
    }
  }
  return [...before, ...children, ...after];
}

function chainPermutations(depth: number): ChainToken[][] {
  const tokens: ChainToken[] = ['section', 'quote', 'bullet', 'ordered'];
  const results: ChainToken[][] = [];

  function visit(current: ChainToken[]) {
    if (current.length === depth) {
      results.push(current);
      return;
    }
    for (const token of tokens) {
      visit([...current, token]);
    }
  }

  visit([]);
  return results;
}

function supportsGeneratedRoundtrip(
  chain: ChainToken[],
  _leaf: LeafToken,
  augmentations: Augmentation[],
): boolean {
  return (
    supportsSectionPrefixOnly(chain) &&
    supportsGeneratedAugmentations(chain, augmentations) &&
    supportsStableQuoteRoundtripShapes(chain, augmentations)
  );
}

function supportsGeneratedIncremental(
  chain: ChainToken[],
  augmentations: Augmentation[],
): boolean {
  return (
    supportsSectionPrefixOnly(chain) &&
    supportsStableQuoteIncrementalShapes(chain, augmentations)
  );
}

function supportsSectionPrefixOnly(chain: ChainToken[]): boolean {
  let sawNonSection = false;
  for (const token of chain) {
    if (token === 'section') {
      if (sawNonSection) return false;
      continue;
    }
    sawNonSection = true;
  }
  return true;
}

function supportsGeneratedAugmentations(
  chain: ChainToken[],
  augmentations: Augmentation[],
): boolean {
  for (const augmentation of augmentations) {
    if (augmentation.kind === 'root-block') {
      if (augmentation.sibling === 'empty-paragraph') {
        return false;
      }
      continue;
    }
    if (
      augmentation.sibling === 'empty-paragraph' &&
      chain
        .slice(0, augmentation.depth + 1)
        .some((token) => token === 'section' || token === 'quote')
    ) {
      return false;
    }
  }
  return true;
}

function supportsStableQuoteRoundtripShapes(
  chain: ChainToken[],
  augmentations: Augmentation[],
): boolean {
  return !augmentations.some((augmentation) => {
    if (
      augmentation.kind === 'container-block' &&
      augmentation.sibling === 'paragraph'
    ) {
      return (
        chain.slice(0, augmentation.depth + 1).includes('quote') &&
        (chain[augmentation.depth] === 'bullet' ||
          chain[augmentation.depth] === 'ordered')
      );
    }
    if (augmentation.kind === 'list-sibling-item') {
      return chain.slice(0, augmentation.depth + 1).includes('quote');
    }
    return false;
  });
}

function supportsStableQuoteIncrementalShapes(
  chain: ChainToken[],
  augmentations: Augmentation[],
): boolean {
  return !augmentations.some((augmentation) => {
    if (
      augmentation.kind === 'container-block' &&
      augmentation.sibling === 'paragraph'
    ) {
      return (
        chain.slice(0, augmentation.depth + 1).includes('quote') &&
        (chain[augmentation.depth] === 'bullet' ||
          chain[augmentation.depth] === 'ordered')
      );
    }
    if (augmentation.kind === 'list-sibling-item') {
      return chain.slice(0, augmentation.depth + 1).includes('quote');
    }
    return false;
  });
}

function canonicalizeGeneratedDocument(doc: DocumentNode): DocumentNode {
  const tree = new MarkdownTree(structuredClone(doc));
  tree.edit(() => ({}), false, {force: true});
  return tree.serialize() as DocumentNode;
}

function isCanonicalGeneratedDocument(doc: DocumentNode): boolean {
  return JSON.stringify(canonicalizeGeneratedDocument(doc)) === JSON.stringify(doc);
}

function augmentationPermutations(chain: ChainToken[]): Augmentation[][] {
  return augmentationPermutationsForMode(chain, RUN_EXTENSIVE);
}

function augmentationPermutationsForMode(
  chain: ChainToken[],
  extensive: boolean,
): Augmentation[][] {
  const simpleSiblingKinds: SiblingKind[] = ['paragraph'];
  const extensiveSiblingKinds: SiblingKind[] = [
    'paragraph',
    'empty-paragraph',
    'quote',
    'bullet',
    'ordered',
    'code-block',
  ];
  const siblingKinds = extensive ? extensiveSiblingKinds : simpleSiblingKinds;
  const singles: Augmentation[] = [];

  for (const sibling of siblingKinds) {
    singles.push({kind: 'root-block', position: 'before', sibling});
    singles.push({kind: 'root-block', position: 'after', sibling});
  }

  for (let i = 0; i < chain.length; i++) {
    const token = chain[i];
    for (const sibling of siblingKinds) {
      singles.push({
        kind: 'container-block',
        depth: i,
        position: 'before',
        sibling,
      });
      singles.push({
        kind: 'container-block',
        depth: i,
        position: 'after',
        sibling,
      });
    }
    if (token === 'bullet' || token === 'ordered') {
      for (const sibling of siblingKinds) {
        singles.push({
          kind: 'list-sibling-item',
          depth: i,
          position: 'before',
          sibling,
        });
        singles.push({
          kind: 'list-sibling-item',
          depth: i,
          position: 'after',
          sibling,
        });
      }
    }
  }

  const results: Augmentation[][] = [[]];
  for (const augmentation of singles) {
    results.push([augmentation]);
  }

  if (extensive) {
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        results.push([singles[i], singles[j]]);
      }
    }
  } else {
    const rootBefore = singles.find(
      (augmentation) =>
        augmentation.kind === 'root-block' &&
        augmentation.position === 'before' &&
        augmentation.sibling === 'paragraph',
    );
    const deepestContainerAfter = [...singles]
      .reverse()
      .find(
        (augmentation) =>
          augmentation.kind === 'container-block' &&
          augmentation.position === 'after' &&
          augmentation.sibling === 'paragraph',
      );
    if (rootBefore && deepestContainerAfter) {
      results.push([rootBefore, deepestContainerAfter]);
    }
  }

  return results;
}

function generatedCanonicalCases() {
  return generatedCanonicalCasesForMode(RUN_EXTENSIVE);
}

function generatedCanonicalCasesForMode(extensive: boolean): NamedGeneratedCase[] {
  const seenMarkdown = new Set<string>();
  const cases: NamedGeneratedCase[] = [];
  const chains = [
    ...chainPermutations(2),
    ...chainPermutations(3),
  ];
  const leaves: LeafToken[] = ['paragraph', 'code-block'];

  for (const chain of chains) {
    for (const leaf of leaves) {
      for (const augmentations of augmentationPermutationsForMode(
        chain,
        extensive,
      )) {
        if (!supportsGeneratedRoundtrip(chain, leaf, augmentations)) {
          continue;
        }
        const candidate = buildRoundtripDocument(chain, leaf, augmentations);
        if (!isCanonicalGeneratedDocument(candidate)) {
          continue;
        }
        const expected = canonicalizeGeneratedDocument(candidate);
        const markdown = serializeToString(expected);
        if (seenMarkdown.has(markdown)) {
          continue;
        }
        seenMarkdown.add(markdown);
        cases.push({
          name: generatedCaseName(chain, leaf, augmentations),
          chain,
          leaf,
          augmentations,
          expected,
          markdown,
        });
      }
    }
  }

  return cases;
}

function generatedCaseName(
  chain: ChainToken[],
  leaf: LeafToken,
  augmentations: Augmentation[],
): string {
  const chainPart = chain.length ? chain.join(' > ') : 'root';
  const augmentationPart =
    augmentations.length === 0
      ? 'no-augmentations'
      : augmentations.map(describeAugmentation).join(' + ');
  return `${leaf} | ${chainPart} | ${augmentationPart}`;
}

function describeAugmentation(augmentation: Augmentation): string {
  switch (augmentation.kind) {
    case 'root-block':
      return `root-${augmentation.position}-${augmentation.sibling}`;
    case 'container-block':
      return `container-${augmentation.depth}-${augmentation.position}-${augmentation.sibling}`;
    case 'list-sibling-item':
      return `list-${augmentation.depth}-${augmentation.position}-${augmentation.sibling}`;
  }
}

describe('block parser generated permutations', () => {
  it('roundtrips generated nested and sibling-bearing permutations through serialize and parse', () => {
    for (const testCase of generatedCanonicalCasesForMode(false)) {
      const {expected, markdown, name} = testCase;
      const reparsed = parseBlocks(markdown).node;
      try {
        expect(reparsed).toEqual(expected);
      } catch (error) {
        throw formatGeneratedCaseFailure(
          name,
          markdown,
          expected,
          reparsed,
          error,
        );
      }
    }
  });

  it('matches full parse for generated paragraph nested and sibling-bearing permutations under char-by-char append', () => {
    for (const testCase of generatedCanonicalCasesForMode(false)) {
      const {chain, leaf, expected, markdown, name} = testCase;
      if (
        leaf !== 'paragraph' ||
        !supportsGeneratedIncremental(chain, testCase.augmentations)
      ) {
        continue;
      }
      const parser = createBlockParser();
      for (const char of markdown) {
        parser.push(char);
      }
      const incremental = parser.finish().serialize();
      try {
        expect(incremental).toEqual(expected);
      } catch (error) {
        throw formatGeneratedCaseFailure(
          name,
          markdown,
          expected,
          incremental as DocumentNode,
          error,
        );
      }
    }
  });

  it('matches full parse for generated code-block nested and sibling-bearing permutations under char-by-char append', () => {
    for (const testCase of generatedCanonicalCasesForMode(false)) {
      const {chain, leaf, expected, markdown, name} = testCase;
      if (
        leaf !== 'code-block' ||
        !supportsGeneratedIncremental(chain, testCase.augmentations)
      ) {
        continue;
      }
      const parser = createBlockParser();
      for (const char of markdown) {
        parser.push(char);
      }
      const incremental = parser.finish().serialize();
      try {
        expect(incremental).toEqual(expected);
      } catch (error) {
        throw formatGeneratedCaseFailure(
          name,
          markdown,
          expected,
          incremental as DocumentNode,
          error,
        );
      }
    }
  });
});

if (RUN_EXTENSIVE) {
  describe('block parser extensive generated permutations', () => {
    const extensiveCases = generatedCanonicalCasesForMode(true);
    const namedExtensiveCases = extensiveCases.map((testCase) => [
      testCase.name,
      testCase,
    ] as const);

    it.each(namedExtensiveCases)(
      'roundtrips %s through serialize and parse',
      (_name, {expected, markdown}) => {
        const reparsed = parseBlocks(markdown).node;
        expect(reparsed).toEqual(expected);
      },
    );

    const extensiveParagraphCases = extensiveCases.filter(
      ({chain, leaf, augmentations}) =>
        leaf === 'paragraph' &&
        supportsGeneratedIncremental(chain, augmentations),
    );
    const namedExtensiveParagraphCases = extensiveParagraphCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedExtensiveParagraphCases)(
      'matches char-by-char append parity for %s',
      (_name, {expected, markdown}) => {
        const parser = createBlockParser();
        for (const char of markdown) {
          parser.push(char);
        }
        expect(parser.finish().serialize()).toEqual(expected);
      },
    );

    const extensiveCodeBlockCases = extensiveCases.filter(
      ({chain, leaf, augmentations}) =>
        leaf === 'code-block' &&
        supportsGeneratedIncremental(chain, augmentations),
    );
    const namedExtensiveCodeBlockCases = extensiveCodeBlockCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedExtensiveCodeBlockCases)(
      'matches char-by-char append parity for code block %s',
      (_name, {expected, markdown}) => {
        const parser = createBlockParser();
        for (const char of markdown) {
          parser.push(char);
        }
        expect(parser.finish().serialize()).toEqual(expected);
      },
    );
  });
}
