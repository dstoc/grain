import { type ViewModelNode, viewModel } from './view-model-node.js';

/** Number a newly inserted batch using its pre-existing adjacent run. */
export function numberInsertedItems(items: ViewModelNode[]) {
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const parse = (node: ViewModelNode | undefined) =>
    node?.type === 'list-item' ? /^(\d+)([.)])\s*$/.exec(node.marker) : null;
  const before = first[viewModel].previousSibling;
  const after = last[viewModel].nextSibling;
  const neighbor = parse(before) ? before : parse(after) ? after : undefined;
  if (!neighbor) return;
  const delimiter = parse(neighbor)![2];
  let start = neighbor;
  while (
    !items.includes(start[viewModel].previousSibling!) &&
    parse(start[viewModel].previousSibling)?.[2] === delimiter
  ) {
    start = start[viewModel].previousSibling!;
  }
  let number = BigInt(parse(start)![1]);
  // Inserted items are included even if their original delimiter differs.
  const batch = new Set(items);
  if (neighbor === after) start = first;
  for (let node: ViewModelNode | undefined = start; node; node = node[viewModel].nextSibling) {
    if (!batch.has(node) && parse(node)?.[2] !== delimiter) break;
    if (node.type !== 'list-item') break;
    const marker = `${number}${delimiter} `;
    if (node.marker !== marker) node[viewModel].updateMarker(marker);
    number++;
  }
}
