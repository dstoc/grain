import {describe, expect, it} from 'vitest';

import {createBlockParser, parseBlocks} from './block-parser.js';
import {serializeToString} from './block-serializer.js';
import type {DocumentNode, MarkdownNode} from './node.js';
import {MarkdownTree} from './view-model.js';

type ChainToken = 'section' | 'quote' | 'bullet' | 'ordered';
type LeafToken = 'paragraph' | 'code-block';
type Augmentation =
  | {kind: 'root-block'; position: 'before' | 'after'}
  | {kind: 'container-block'; depth: number; position: 'before' | 'after'}
  | {kind: 'list-sibling-item'; depth: number; position: 'before' | 'after'};

interface GeneratedCase {
  chain: ChainToken[];
  leaf: LeafToken;
  augmentations: Augmentation[];
  expected: DocumentNode;
  markdown: string;
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

function withRootBlockAugmentations(
  children: MarkdownNode[],
  augmentations: Augmentation[],
) {
  return applyBlockAugmentations(children, augmentations, (augmentation) =>
    augmentation.kind === 'root-block'
      ? siblingParagraph(`root ${augmentation.position}`)
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
      ? siblingParagraph(`container ${depth} ${augmentation.position}`)
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
          children: [siblingParagraph(`list ${depth} ${augmentation.position}`)],
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
    supportsGeneratedAugmentations(chain, augmentations)
  );
}

function supportsGeneratedIncremental(chain: ChainToken[]): boolean {
  return supportsSectionPrefixOnly(chain);
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
      continue;
    }
    if (chain.slice(0, augmentation.depth + 1).includes('quote')) {
      return false;
    }
  }
  return true;
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
  const singles: Augmentation[] = [
    {kind: 'root-block', position: 'before'},
    {kind: 'root-block', position: 'after'},
  ];

  for (let i = 0; i < chain.length; i++) {
    const token = chain[i];
    if (token !== 'quote') {
      singles.push({kind: 'container-block', depth: i, position: 'before'});
      singles.push({kind: 'container-block', depth: i, position: 'after'});
    }
    if (token === 'bullet' || token === 'ordered') {
      singles.push({kind: 'list-sibling-item', depth: i, position: 'before'});
      singles.push({kind: 'list-sibling-item', depth: i, position: 'after'});
    }
  }

  const results: Augmentation[][] = [[]];
  for (const augmentation of singles) {
    results.push([augmentation]);
  }

  const rootBefore = singles.find(
    (augmentation) =>
      augmentation.kind === 'root-block' && augmentation.position === 'before',
  );
  const deepestContainerAfter = [...singles]
    .reverse()
    .find(
      (augmentation) =>
        augmentation.kind === 'container-block' &&
        augmentation.position === 'after',
    );
  if (rootBefore && deepestContainerAfter) {
    results.push([rootBefore, deepestContainerAfter]);
  }

  return results;
}

function generatedCanonicalCases() {
  const seenMarkdown = new Set<string>();
  const cases: GeneratedCase[] = [];
  const chains = [
    ...chainPermutations(2),
    ...chainPermutations(3),
  ];
  const leaves: LeafToken[] = ['paragraph', 'code-block'];

  for (const chain of chains) {
    for (const leaf of leaves) {
      for (const augmentations of augmentationPermutations(chain)) {
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
        cases.push({chain, leaf, augmentations, expected, markdown});
      }
    }
  }

  return cases;
}

describe('block parser generated permutations', () => {
  it('roundtrips generated nested and sibling-bearing permutations through serialize and parse', () => {
    for (const {expected, markdown} of generatedCanonicalCases()) {
        const reparsed = parseBlocks(markdown).node;
        expect(reparsed).toEqual(expected);
    }
  });

  it('matches full parse for generated paragraph nested and sibling-bearing permutations under char-by-char append', () => {
    for (const {chain, leaf, expected, markdown} of generatedCanonicalCases()) {
      if (leaf !== 'paragraph' || !supportsGeneratedIncremental(chain)) {
        continue;
      }
      const parser = createBlockParser();
      for (const char of markdown) {
        parser.push(char);
      }
      expect(parser.finish().serialize()).toEqual(expected);
    }
  });

  it('matches full parse for generated code-block nested and sibling-bearing permutations under char-by-char append', () => {
    for (const {chain, leaf, expected, markdown} of generatedCanonicalCases()) {
      if (leaf !== 'code-block' || !supportsGeneratedIncremental(chain)) {
        continue;
      }
      const parser = createBlockParser();
      for (const char of markdown) {
        parser.push(char);
      }
      expect(parser.finish().serialize()).toEqual(expected);
    }
  });
});
