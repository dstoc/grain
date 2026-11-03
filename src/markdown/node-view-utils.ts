import type { ReadonlyMarkdownNodeView } from './node-view.js';

/** Compares two renderer node views that belong to the same document tree. */
export function compareDocumentOrder(
  first: ReadonlyMarkdownNodeView,
  second: ReadonlyMarkdownNodeView,
): number {
  if (first === second) return 0;
  const ancestors = (node: ReadonlyMarkdownNodeView) => {
    const chain: ReadonlyMarkdownNodeView[] = [];
    for (let parent = node.parent; parent; parent = parent.parent) chain.push(parent);
    return chain;
  };
  const firstChain = [first, ...ancestors(first)];
  const secondChain = [second, ...ancestors(second)];
  if (firstChain.at(-1) !== secondChain.at(-1)) {
    throw new Error('document order requires nodes from the same root');
  }
  while (firstChain.at(-1) === secondChain.at(-1)) {
    firstChain.pop();
    secondChain.pop();
  }
  if (!firstChain.length) return -1;
  if (!secondChain.length) return 1;
  const firstBranch = firstChain.at(-1)!;
  const secondBranch = secondChain.at(-1)!;
  const siblings = firstBranch.parent?.children ?? [];
  return siblings.indexOf(firstBranch) < siblings.indexOf(secondBranch) ? -1 : 1;
}
