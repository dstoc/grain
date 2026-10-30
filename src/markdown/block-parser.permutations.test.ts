import { describe, expect, it } from 'vitest';

import { createBlockParser, parseBlocks } from './block-parser/api.js';
import { serializeToString } from './block-serializer.js';
import type { DocumentNode, MarkdownNode } from './node.js';
import { MarkdownTree } from './view-model.js';
import { viewModel } from './view-model-node.js';
import { DEFAULT_UNSUPPORTED_GENERATED_CASE_NAMES } from './block-parser.permutations.default-skips.js';

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
  | { kind: 'root-block'; position: 'before' | 'after'; sibling: SiblingKind }
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
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.MARKDOWN_EXTENSIVE_TESTS === '1';
const RUN_EXTENSIVE_SMOKE =
  (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.MARKDOWN_EXTENSIVE_SMOKE_TESTS === '1';

type GeneratedMode = 'default' | 'extensive-smoke' | 'extensive';

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

type VisibleContentNodeType = 'paragraph' | 'code-block' | 'section';

interface VisibleContentSnapshot {
  nodeId: number;
  identity: string;
  path: string;
  type: VisibleContentNodeType;
  contentLength: number;
}

interface IncrementalChunkSchedule {
  name: string;
  chunks(markdown: string): string[];
}

interface IncrementalScheduleRun {
  name: string;
  checkpoints: Map<number, DocumentNode>;
  finalTree: DocumentNode;
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
      ? { type: 'paragraph', content: chainLabel(chain) }
      : { type: 'code-block', info: 'ts', content: chainLabel(chain) };

  for (let i = chain.length - 1; i >= 0; i--) {
    const token = chain[i];
    switch (token) {
      case 'section': {
        const children = withContainerBlockAugmentations(
          [node],
          augmentations,
          i,
        );
        node = {
          type: 'section',
          marker: '#'.repeat(sectionDepths.get(i) ?? 1),
          content: `section ${i + 1}`,
          children,
        };
        break;
      }
      case 'quote': {
        const children = withContainerBlockAugmentations(
          [node],
          augmentations,
          i,
        );
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
        const children = withListSiblingItemAugmentations(
          [item],
          augmentations,
          i,
        );
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
      return { type: 'paragraph', content: '' };
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
    if (
      augmentation.sibling === 'empty-paragraph' &&
      augmentation.position === 'before'
    ) {
      return false;
    }
  }
  return true;
}

function supportsStableQuoteRoundtripShapes(
  _chain: ChainToken[],
  _augmentations: Augmentation[],
): boolean {
  return true;
}

function supportsStableQuoteIncrementalShapes(
  _chain: ChainToken[],
  _augmentations: Augmentation[],
): boolean {
  return true;
}

function canonicalizeGeneratedDocument(doc: DocumentNode): DocumentNode {
  const tree = new MarkdownTree(structuredClone(doc));
  tree.edit(() => ({}), false, { force: true });
  return tree.serialize() as DocumentNode;
}

function isCanonicalGeneratedDocument(doc: DocumentNode): boolean {
  return (
    JSON.stringify(canonicalizeGeneratedDocument(doc)) === JSON.stringify(doc)
  );
}

function augmentationPermutationsForMode(
  chain: ChainToken[],
  mode: GeneratedMode,
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
  const siblingKinds =
    mode === 'default' ? simpleSiblingKinds : extensiveSiblingKinds;
  const singles: Augmentation[] = [];

  for (const sibling of siblingKinds) {
    singles.push({ kind: 'root-block', position: 'before', sibling });
    singles.push({ kind: 'root-block', position: 'after', sibling });
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

  if (mode !== 'default') {
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        if (isUnresolvedDoublyQuotedListPair(chain, singles[i], singles[j])) {
          continue;
        }
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

function isUnresolvedDoublyQuotedListPair(
  chain: ChainToken[],
  first: Augmentation,
  second: Augmentation,
): boolean {
  const augmentations = [first, second];
  const listAncestorChain =
    chain.length === 3 &&
    (chain[0] === 'bullet' || chain[0] === 'ordered') &&
    chain[1] === 'quote' &&
    chain[2] === 'quote';
  if (!listAncestorChain) return false;

  const hasDepth1After = augmentations.some(
    (augmentation) =>
      augmentation.kind === 'container-block' &&
      augmentation.depth === 1 &&
      augmentation.position === 'after' &&
      ['paragraph', 'bullet', 'ordered', 'code-block'].includes(
        augmentation.sibling,
      ),
  );
  const hasDepth2AfterQuote = augmentations.some(
    (augmentation) =>
      augmentation.kind === 'container-block' &&
      augmentation.depth === 2 &&
      augmentation.position === 'after' &&
      augmentation.sibling === 'quote',
  );
  if (hasDepth1After && hasDepth2AfterQuote) return true;

  const hasDepth2BeforeParagraph = augmentations.some(
    (augmentation) =>
      augmentation.kind === 'container-block' &&
      augmentation.depth === 2 &&
      augmentation.position === 'before' &&
      augmentation.sibling === 'paragraph',
  );
  const hasDepth2BeforeQuote = augmentations.some(
    (augmentation) =>
      augmentation.kind === 'container-block' &&
      augmentation.depth === 2 &&
      augmentation.position === 'before' &&
      augmentation.sibling === 'quote',
  );
  if (hasDepth2BeforeParagraph && hasDepth2BeforeQuote) return true;

  const hasDepth2AfterOuterSibling = augmentations.some(
    (augmentation) =>
      augmentation.kind === 'container-block' &&
      augmentation.depth === 2 &&
      augmentation.position === 'after' &&
      ['bullet', 'ordered', 'code-block'].includes(augmentation.sibling),
  );
  return hasDepth2AfterQuote && hasDepth2AfterOuterSibling;
}

function augmentationDepthTag(augmentation: Augmentation): string {
  switch (augmentation.kind) {
    case 'root-block':
      return 'root';
    case 'container-block':
      return `container-${augmentation.depth}`;
    case 'list-sibling-item':
      return `list-${augmentation.depth}`;
  }
}

function generatedCaseContextFeatures(chain: ChainToken[]): string[] {
  const features = [`depth:${chain.length}`];
  if (chain.includes('section')) {
    features.push('context:section');
  }
  if (chain.includes('quote')) {
    features.push('context:quote');
  }
  if (chain.includes('bullet') || chain.includes('ordered')) {
    features.push('context:list');
  }
  return features;
}

function generatedCaseCoverageFeatures(testCase: NamedGeneratedCase): string[] {
  const features = [
    `leaf:${testCase.leaf}`,
    ...generatedCaseContextFeatures(testCase.chain),
  ];

  for (const augmentation of testCase.augmentations) {
    features.push(`aug-kind:${augmentation.kind}`);
    features.push(`aug-position:${augmentation.position}`);
    features.push(`aug-sibling:${augmentation.sibling}`);
    features.push(`aug-depth:${augmentationDepthTag(augmentation)}`);
  }

  if (testCase.augmentations.length === 2) {
    const [first, second] = [...testCase.augmentations].sort((left, right) =>
      describeAugmentation(left).localeCompare(describeAugmentation(right)),
    );
    features.push(`pair-kind:${first.kind}+${second.kind}`);
    features.push(`pair-position:${first.position}+${second.position}`);
    features.push(`pair-sibling:${first.sibling}+${second.sibling}`);
    features.push(
      `pair-depth:${augmentationDepthTag(first)}+${augmentationDepthTag(second)}`,
    );
  }

  return features;
}

function selectExtensiveSmokeCases(
  extensiveCases: NamedGeneratedCase[],
): NamedGeneratedCase[] {
  const smokeCases = extensiveCases.filter(
    (testCase) => testCase.augmentations.length <= 1,
  );
  const selectedNames = new Set(smokeCases.map((testCase) => testCase.name));
  const coveredFeatures = new Set<string>();

  for (const testCase of smokeCases) {
    for (const feature of generatedCaseCoverageFeatures(testCase)) {
      coveredFeatures.add(feature);
    }
  }

  const doubleCases = extensiveCases
    .filter((testCase) => testCase.augmentations.length === 2)
    .sort((left, right) => left.name.localeCompare(right.name));

  for (;;) {
    let bestCase: NamedGeneratedCase | undefined;
    let bestNewFeatureCount = 0;

    for (const testCase of doubleCases) {
      if (selectedNames.has(testCase.name)) {
        continue;
      }

      const newFeatureCount = generatedCaseCoverageFeatures(testCase).filter(
        (feature) => !coveredFeatures.has(feature),
      ).length;
      if (newFeatureCount > bestNewFeatureCount) {
        bestCase = testCase;
        bestNewFeatureCount = newFeatureCount;
      }
    }

    if (!bestCase || bestNewFeatureCount === 0) {
      break;
    }

    smokeCases.push(bestCase);
    selectedNames.add(bestCase.name);
    for (const feature of generatedCaseCoverageFeatures(bestCase)) {
      coveredFeatures.add(feature);
    }
  }

  return smokeCases;
}

function generatedCanonicalCasesForMode(
  mode: GeneratedMode,
): NamedGeneratedCase[] {
  const seenMarkdown = new Set<string>();
  const cases: NamedGeneratedCase[] = [];
  const chains = [...chainPermutations(2), ...chainPermutations(3)];
  const leaves: LeafToken[] = ['paragraph', 'code-block'];

  for (const chain of chains) {
    for (const leaf of leaves) {
      for (const augmentations of augmentationPermutationsForMode(
        chain,
        mode,
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

  if (mode === 'extensive-smoke') {
    return selectExtensiveSmokeCases(cases);
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

function collectVisibleContentSnapshots(
  tree: MarkdownTree,
): VisibleContentSnapshot[] {
  const snapshots: VisibleContentSnapshot[] = [];

  function visit(node: MarkdownNode, path: string): void {
    if (
      node.type === 'paragraph' ||
      node.type === 'code-block' ||
      node.type === 'section'
    ) {
      const nodeId =
        (
          node as MarkdownNode & {
            [viewModel]?: { id: number };
          }
        )[viewModel]?.id ?? -1;
      snapshots.push({
        nodeId,
        identity: `${path}:${node.type}`,
        path,
        type: node.type,
        contentLength: node.content.length,
      });
    }

    if (!node.children) {
      return;
    }

    for (let index = 0; index < node.children.length; index++) {
      visit(node.children[index], `${path}/${index}`);
    }
  }

  visit(tree.root, 'document');
  return snapshots;
}

function formatVisibleContentGrowthFailure(
  caseName: string,
  markdown: string,
  previousSnapshot: VisibleContentSnapshot[],
  currentSnapshot: VisibleContentSnapshot[],
  detail: string,
): Error {
  return new Error(
    [
      `case: ${caseName}`,
      `markdown:\n${markdown}`,
      `previous snapshot:\n${JSON.stringify(previousSnapshot, null, 2)}`,
      `current snapshot:\n${JSON.stringify(currentSnapshot, null, 2)}`,
      detail,
    ].join('\n\n'),
  );
}

function formatScheduleFailure(
  caseName: string,
  markdown: string,
  scheduleName: string,
  detail: string,
  expected: DocumentNode,
  actual: DocumentNode,
): Error {
  return new Error(
    [
      `case: ${caseName}`,
      `schedule: ${scheduleName}`,
      `markdown:\n${markdown}`,
      `expected:\n${JSON.stringify(expected, null, 2)}`,
      `actual:\n${JSON.stringify(actual, null, 2)}`,
      detail,
    ].join('\n\n'),
  );
}

function formatScheduleCheckpointFailure(
  caseName: string,
  markdown: string,
  checkpointLength: number,
  baselineSchedule: string,
  currentSchedule: string,
  baselineTree: DocumentNode,
  currentTree: DocumentNode,
): Error {
  return new Error(
    [
      `case: ${caseName}`,
      `checkpoint: ${checkpointLength}`,
      `baseline schedule: ${baselineSchedule}`,
      `current schedule: ${currentSchedule}`,
      `markdown:\n${markdown}`,
      `baseline tree:\n${JSON.stringify(baselineTree, null, 2)}`,
      `current tree:\n${JSON.stringify(currentTree, null, 2)}`,
    ].join('\n\n'),
  );
}

const DEFAULT_INCREMENTAL_SCHEDULES: IncrementalChunkSchedule[] = [
  {
    name: 'all-at-once',
    chunks: (markdown) => (markdown ? [markdown] : []),
  },
  {
    name: 'char-by-char',
    chunks: (markdown) => [...markdown],
  },
  {
    name: 'before-first-newline-then-rest',
    chunks: (markdown) => splitBeforeFirstNewline(markdown),
  },
  {
    name: 'through-first-newline-then-rest',
    chunks: (markdown) => splitThroughFirstNewline(markdown),
  },
  {
    name: 'first-line-next-char-then-rest',
    chunks: (markdown) => splitFirstLineThenNextChar(markdown),
  },
];

function splitBeforeFirstNewline(markdown: string): string[] {
  const newlineIndex = markdown.indexOf('\n');
  if (newlineIndex === -1) {
    return markdown ? [markdown] : [];
  }
  return compactChunks([
    markdown.slice(0, newlineIndex),
    markdown.slice(newlineIndex),
  ]);
}

function splitThroughFirstNewline(markdown: string): string[] {
  const newlineIndex = markdown.indexOf('\n');
  if (newlineIndex === -1) {
    return markdown ? [markdown] : [];
  }
  return compactChunks([
    markdown.slice(0, newlineIndex + 1),
    markdown.slice(newlineIndex + 1),
  ]);
}

function splitFirstLineThenNextChar(markdown: string): string[] {
  const newlineIndex = markdown.indexOf('\n');
  if (newlineIndex === -1) {
    return markdown ? [markdown] : [];
  }

  const restStart = newlineIndex + 1;
  return compactChunks([
    markdown.slice(0, restStart),
    markdown.slice(restStart, restStart + 1),
    markdown.slice(restStart + 1),
  ]);
}

function compactChunks(chunks: string[]): string[] {
  return chunks.filter((chunk) => chunk.length > 0);
}

function runIncrementalSchedule(
  markdown: string,
  schedule: IncrementalChunkSchedule,
): IncrementalScheduleRun {
  const parser = createBlockParser();
  const checkpoints = new Map<number, DocumentNode>();
  let consumedLength = 0;

  for (const chunk of schedule.chunks(markdown)) {
    parser.push(chunk);
    consumedLength += chunk.length;
    checkpoints.set(
      consumedLength,
      parser.getTree().serialize() as DocumentNode,
    );
  }

  const finalTree = parser.finish().serialize() as DocumentNode;
  return {
    name: schedule.name,
    checkpoints,
    finalTree,
  };
}

function assertScheduleCoverageAcrossIncrementalParse(
  caseName: string,
  markdown: string,
  expected: DocumentNode,
): void {
  const runs = DEFAULT_INCREMENTAL_SCHEDULES.map((schedule) =>
    runIncrementalSchedule(markdown, schedule),
  );
  const baselineRun =
    runs.find((run) => run.name === 'char-by-char') ?? runs[0];
  if (!baselineRun) {
    return;
  }

  for (const run of runs) {
    try {
      expect(run.finalTree).toEqual(expected);
    } catch (error) {
      throw formatScheduleFailure(
        caseName,
        markdown,
        run.name,
        String(error),
        expected,
        run.finalTree,
      );
    }

    if (run.name === baselineRun.name) {
      continue;
    }

    for (const [checkpointLength, currentTree] of run.checkpoints) {
      const baselineTree = baselineRun.checkpoints.get(checkpointLength);
      if (!baselineTree) {
        continue;
      }

      try {
        expect(currentTree).toEqual(baselineTree);
      } catch {
        throw formatScheduleCheckpointFailure(
          caseName,
          markdown,
          checkpointLength,
          baselineRun.name,
          run.name,
          baselineTree,
          currentTree,
        );
      }
    }
  }
}

function assertVisibleContentGrowth(
  caseName: string,
  markdown: string,
  previousSnapshot: VisibleContentSnapshot[],
  currentSnapshot: VisibleContentSnapshot[],
): void {
  const previousByNodeId = new Map(
    previousSnapshot.map((snapshot) => [snapshot.nodeId, snapshot]),
  );
  const previousByIdentity = new Map(
    previousSnapshot.map((snapshot) => [snapshot.identity, snapshot]),
  );

  for (const snapshot of currentSnapshot) {
    const previous =
      previousByNodeId.get(snapshot.nodeId) ??
      previousByIdentity.get(snapshot.identity);
    if (!previous) {
      if (snapshot.contentLength !== 1) {
        throw formatVisibleContentGrowthFailure(
          caseName,
          markdown,
          previousSnapshot,
          currentSnapshot,
          `new node ${snapshot.identity} started at ${snapshot.contentLength}`,
        );
      }
      continue;
    }

    if (snapshot.contentLength < previous.contentLength) {
      throw formatVisibleContentGrowthFailure(
        caseName,
        markdown,
        previousSnapshot,
        currentSnapshot,
        `node ${snapshot.identity} shrank from ${previous.contentLength} to ${snapshot.contentLength}`,
      );
    }

    if (snapshot.contentLength > previous.contentLength + 1) {
      throw formatVisibleContentGrowthFailure(
        caseName,
        markdown,
        previousSnapshot,
        currentSnapshot,
        `node ${snapshot.identity} grew from ${previous.contentLength} to ${snapshot.contentLength}`,
      );
    }
  }
}

function assertVisibleContentGrowthAcrossIncrementalParse(
  caseName: string,
  markdown: string,
  parser: ReturnType<typeof createBlockParser>,
): void {
  let previousSnapshot = collectVisibleContentSnapshots(parser.getTree());

  for (let index = 0; index < markdown.length; index++) {
    const char = markdown[index];
    parser.push(char);
    const currentSnapshot = collectVisibleContentSnapshots(parser.getTree());
    if (shouldAssertVisibleContentGrowthCheckpoint(markdown, index)) {
      assertVisibleContentGrowth(
        caseName,
        markdown,
        previousSnapshot,
        currentSnapshot,
      );
    }
    previousSnapshot = currentSnapshot;
  }
}

function shouldAssertVisibleContentGrowthCheckpoint(
  markdown: string,
  charIndex: number,
): boolean {
  const lineStart = markdown.lastIndexOf('\n', charIndex - 1) + 1;
  const contentStart = getVisibleContentStartIndex(markdown, lineStart);
  if (contentStart === -1 || charIndex < contentStart) {
    return false;
  }

  return true;
}

function getVisibleContentStartIndex(
  markdown: string,
  lineStart: number,
): number {
  let index = lineStart;
  while (index < markdown.length) {
    const char = markdown[index];
    if (char === ' ' || char === '\t') {
      index++;
      continue;
    }
    break;
  }

  if (index >= markdown.length) {
    return -1;
  }

  for (;;) {
    while (markdown[index] === ' ' || markdown[index] === '\t') {
      index++;
    }

    if (index >= markdown.length) {
      return -1;
    }

    const first = markdown[index];
    if (first === '`') {
      return -1;
    }

    if (first === '#') {
      while (markdown[index] === '#') {
        index++;
      }
      continue;
    }

    if (first === '>') {
      index++;
      continue;
    }

    if (first === '*' || first === '-' || first === '+') {
      index++;
      continue;
    }

    if (first >= '0' && first <= '9') {
      const start = index;
      while (markdown[index] >= '0' && markdown[index] <= '9') {
        index++;
      }
      if (markdown[index] === '.' || markdown[index] === ')') {
        index++;
        continue;
      }
      return start;
    }

    return index;
  }
}

describe('block parser content growth heuristic helpers', () => {
  it('collects visible content-bearing nodes with path-based identities in document order', () => {
    const tree = new MarkdownTree({
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '#',
          content: 'root',
          children: [
            { type: 'paragraph', content: 'a' },
            { type: 'code-block', info: 'ts', content: 'bb' },
            {
              type: 'section',
              marker: '##',
              content: 'ccc',
              children: [{ type: 'paragraph', content: 'dddd' }],
            },
          ],
        },
        { type: 'paragraph', content: 'ee' },
      ],
    });

    expect(collectVisibleContentSnapshots(tree)).toEqual([
      {
        nodeId: expect.any(Number) as number,
        identity: 'document/0:section',
        path: 'document/0',
        type: 'section',
        contentLength: 4,
      },
      {
        nodeId: expect.any(Number) as number,
        identity: 'document/0/0:paragraph',
        path: 'document/0/0',
        type: 'paragraph',
        contentLength: 1,
      },
      {
        nodeId: expect.any(Number) as number,
        identity: 'document/0/1:code-block',
        path: 'document/0/1',
        type: 'code-block',
        contentLength: 2,
      },
      {
        nodeId: expect.any(Number) as number,
        identity: 'document/0/2:section',
        path: 'document/0/2',
        type: 'section',
        contentLength: 3,
      },
      {
        nodeId: expect.any(Number) as number,
        identity: 'document/0/2/0:paragraph',
        path: 'document/0/2/0',
        type: 'paragraph',
        contentLength: 4,
      },
      {
        nodeId: expect.any(Number) as number,
        identity: 'document/0/2/1:paragraph',
        path: 'document/0/2/1',
        type: 'paragraph',
        contentLength: 2,
      },
    ]);
  });

  it('accepts the expected visible-content growth progression', () => {
    const previousSnapshot: VisibleContentSnapshot[] = [
      {
        nodeId: 1,
        identity: 'document/0:paragraph',
        path: 'document/0',
        type: 'paragraph',
        contentLength: 1,
      },
    ];
    const currentSnapshot: VisibleContentSnapshot[] = [
      {
        nodeId: 1,
        identity: 'document/0:paragraph',
        path: 'document/0',
        type: 'paragraph',
        contentLength: 2,
      },
      {
        nodeId: 2,
        identity: 'document/1:code-block',
        path: 'document/1',
        type: 'code-block',
        contentLength: 1,
      },
      {
        nodeId: 3,
        identity: 'document/2:section',
        path: 'document/2',
        type: 'section',
        contentLength: 1,
      },
    ];

    expect(() =>
      assertVisibleContentGrowth(
        'helper progression',
        'abc',
        previousSnapshot,
        currentSnapshot,
      ),
    ).not.toThrow();
  });

  it('rejects newly visible content-bearing nodes that start above length one', () => {
    const previousSnapshot: VisibleContentSnapshot[] = [
      {
        nodeId: 1,
        identity: 'document/0:paragraph',
        path: 'document/0',
        type: 'paragraph',
        contentLength: 1,
      },
    ];
    const currentSnapshot: VisibleContentSnapshot[] = [
      {
        nodeId: 1,
        identity: 'document/0:paragraph',
        path: 'document/0',
        type: 'paragraph',
        contentLength: 1,
      },
      {
        nodeId: 2,
        identity: 'document/1:section',
        path: 'document/1',
        type: 'section',
        contentLength: 2,
      },
    ];

    expect(() =>
      assertVisibleContentGrowth(
        'helper growth allowance',
        'abcd',
        previousSnapshot,
        currentSnapshot,
      ),
    ).toThrowError(/new node document\/1:section started at 2/);
  });

  it('rejects visible content nodes that grow by more than one character', () => {
    const previousSnapshot: VisibleContentSnapshot[] = [
      {
        nodeId: 1,
        identity: 'document/0:section',
        path: 'document/0',
        type: 'section',
        contentLength: 3,
      },
    ];
    const currentSnapshot: VisibleContentSnapshot[] = [
      {
        nodeId: 1,
        identity: 'document/0:section',
        path: 'document/0',
        type: 'section',
        contentLength: 5,
      },
    ];

    expect(() =>
      assertVisibleContentGrowth(
        'helper growth failure',
        'abcd',
        previousSnapshot,
        currentSnapshot,
      ),
    ).toThrowError(/node document\/0:section grew from 3 to 5/);
  });

  it('skips checkpoint assertions while appending list markers', () => {
    expect(shouldAssertVisibleContentGrowthCheckpoint('- item', 0)).toBe(false);
    expect(shouldAssertVisibleContentGrowthCheckpoint('- item', 1)).toBe(false);
    expect(shouldAssertVisibleContentGrowthCheckpoint('- item', 2)).toBe(true);
    expect(shouldAssertVisibleContentGrowthCheckpoint('> - item', 0)).toBe(
      false,
    );
    expect(shouldAssertVisibleContentGrowthCheckpoint('> - item', 2)).toBe(
      false,
    );
    expect(shouldAssertVisibleContentGrowthCheckpoint('> - item', 4)).toBe(
      true,
    );
  });
});

describe('block parser generated permutations', () => {
  it('roundtrips generated nested and sibling-bearing permutations through serialize and parse', () => {
    for (const testCase of generatedCanonicalCasesForMode('default')) {
      const { expected, markdown, name, leaf } = testCase;
      if (
        isUnsupportedDefaultRoundtripNestedQuoteCase(
          testCase.chain,
          leaf,
          testCase.augmentations,
        )
      ) {
        continue;
      }
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
    for (const testCase of generatedCanonicalCasesForMode('default')) {
      const { chain, leaf, expected, markdown, name } = testCase;
      if (
        isUnsupportedDefaultIncrementalNestedQuoteCase(
          chain,
          leaf,
          testCase.augmentations,
        )
      ) {
        continue;
      }
      if (
        leaf !== 'paragraph' ||
        !supportsGeneratedIncremental(chain, testCase.augmentations)
      ) {
        continue;
      }
      assertScheduleCoverageAcrossIncrementalParse(name, markdown, expected);
      const parser = createBlockParser();
      assertVisibleContentGrowthAcrossIncrementalParse(name, markdown, parser);
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
    for (const testCase of generatedCanonicalCasesForMode('default')) {
      const { chain, leaf, expected, markdown, name } = testCase;
      if (
        isUnsupportedDefaultCodeBlockIncrementalCase(
          chain,
          leaf,
          testCase.augmentations,
        )
      ) {
        continue;
      }
      if (
        leaf !== 'code-block' ||
        !supportsGeneratedIncremental(chain, testCase.augmentations)
      ) {
        continue;
      }
      assertScheduleCoverageAcrossIncrementalParse(name, markdown, expected);
      const parser = createBlockParser();
      assertVisibleContentGrowthAcrossIncrementalParse(name, markdown, parser);
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

function isUnsupportedDefaultRoundtripNestedQuoteCase(
  chain: ChainToken[],
  leaf: LeafToken,
  augmentations: Augmentation[],
): boolean {
  return DEFAULT_UNSUPPORTED_GENERATED_CASE_NAMES.has(
    generatedCaseName(chain, leaf, augmentations),
  );
}

function isUnsupportedDefaultIncrementalNestedQuoteCase(
  chain: ChainToken[],
  leaf: LeafToken,
  augmentations: Augmentation[],
): boolean {
  return DEFAULT_UNSUPPORTED_GENERATED_CASE_NAMES.has(
    generatedCaseName(chain, leaf, augmentations),
  );
}

function isUnsupportedDefaultCodeBlockIncrementalCase(
  chain: ChainToken[],
  leaf: LeafToken,
  augmentations: Augmentation[],
): boolean {
  return DEFAULT_UNSUPPORTED_GENERATED_CASE_NAMES.has(
    generatedCaseName(chain, leaf, augmentations),
  );
}

if (RUN_EXTENSIVE_SMOKE) {
  describe('block parser extensive smoke generated permutations', () => {
    const smokeCases = generatedCanonicalCasesForMode('extensive-smoke');
    const namedSmokeCases = smokeCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedSmokeCases)(
      'roundtrips %s through serialize and parse',
      (_name, { expected, markdown }) => {
        const reparsed = parseBlocks(markdown).node;
        expect(reparsed).toEqual(expected);
      },
    );

    const smokeParagraphCases = smokeCases.filter(
      ({ chain, leaf, augmentations }) =>
        leaf === 'paragraph' &&
        supportsGeneratedIncremental(chain, augmentations),
    );
    const namedSmokeParagraphCases = smokeParagraphCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedSmokeParagraphCases)(
      'matches char-by-char append parity for %s',
      (_name, { expected, markdown }) => {
        const parser = createBlockParser();
        for (const char of markdown) {
          parser.push(char);
        }
        expect(parser.finish().serialize()).toEqual(expected);
      },
    );

    const smokeCodeBlockCases = smokeCases.filter(
      ({ chain, leaf, augmentations }) =>
        leaf === 'code-block' &&
        supportsGeneratedIncremental(chain, augmentations),
    );
    const namedSmokeCodeBlockCases = smokeCodeBlockCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedSmokeCodeBlockCases)(
      'matches char-by-char append parity for code block %s',
      (_name, { expected, markdown }) => {
        const parser = createBlockParser();
        for (const char of markdown) {
          parser.push(char);
        }
        expect(parser.finish().serialize()).toEqual(expected);
      },
    );
  });
}

if (RUN_EXTENSIVE) {
  describe('block parser extensive generated permutations', () => {
    const extensiveCases = generatedCanonicalCasesForMode('extensive');
    const namedExtensiveCases = extensiveCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedExtensiveCases)(
      'roundtrips %s through serialize and parse',
      (_name, { expected, markdown }) => {
        const reparsed = parseBlocks(markdown).node;
        expect(reparsed).toEqual(expected);
      },
    );

    const extensiveParagraphCases = extensiveCases.filter(
      ({ chain, leaf, augmentations }) =>
        leaf === 'paragraph' &&
        supportsGeneratedIncremental(chain, augmentations),
    );
    const namedExtensiveParagraphCases = extensiveParagraphCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedExtensiveParagraphCases)(
      'matches char-by-char append parity for %s',
      (_name, { expected, markdown }) => {
        const parser = createBlockParser();
        for (const char of markdown) {
          parser.push(char);
        }
        expect(parser.finish().serialize()).toEqual(expected);
      },
    );

    const extensiveCodeBlockCases = extensiveCases.filter(
      ({ chain, leaf, augmentations }) =>
        leaf === 'code-block' &&
        supportsGeneratedIncremental(chain, augmentations),
    );
    const namedExtensiveCodeBlockCases = extensiveCodeBlockCases.map(
      (testCase) => [testCase.name, testCase] as const,
    );

    it.each(namedExtensiveCodeBlockCases)(
      'matches char-by-char append parity for code block %s',
      (_name, { expected, markdown }) => {
        const parser = createBlockParser();
        for (const char of markdown) {
          parser.push(char);
        }
        expect(parser.finish().serialize()).toEqual(expected);
      },
    );
  });
}
