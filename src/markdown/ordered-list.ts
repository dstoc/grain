import { type ViewModelNode, viewModel } from './view-model-node.js';

/** Number a newly inserted batch using its pre-existing adjacent run. */
export function renumberInsertedItems(items: ViewModelNode[]) {
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

/** Capture list runs before an edit and reconcile runs affected by item transfers. */
export function renumberListMoves(root: ViewModelNode, edit: () => void) {
  type Run = { items: ViewModelNode[]; markers: string[]; parent: ViewModelNode };
  const runs: Run[] = [];
  const parents = new Map<ViewModelNode, ViewModelNode>();
  const numeric = (node: ViewModelNode | undefined) =>
    node?.type === 'list-item' ? /^(\d+)([.)])\s*$/.exec(node.marker) : null;
  function visit(node: ViewModelNode) {
    if (node.type === 'list') {
      let run: Run | undefined;
      for (const item of node.children ?? []) {
        parents.set(item, node);
        const marker = numeric(item);
        if (!marker) run = undefined;
        else {
          if (!run || numeric(run.items[0])?.[2] !== marker[2]) {
            run = { items: [], markers: [], parent: node };
            runs.push(run);
          }
          run.items.push(item);
          run.markers.push(item.type === 'list-item' ? item.marker : '');
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(root);
  edit();
  const moved = new Set(
    [...parents]
      .filter(([item, parent]) => item[viewModel].parent !== parent)
      .map(([item]) => item),
  );
  // Wrappers created during indentation have no pre-edit parent to compare.
  function collectNewItems(node: ViewModelNode) {
    if (node.type === 'list-item' && !parents.has(node)) moved.add(node);
    for (const child of node.children ?? []) collectNewItems(child);
  }
  collectNewItems(root);
  const renumber = (items: ViewModelNode[], marker: string) => {
    const parsed = /^(\d+)([.)])/.exec(marker)!;
    let n = BigInt(parsed[1]);
    for (const item of items) {
      if (item.type === 'list-item') item[viewModel].updateMarker(`${n++}${parsed[2]} `);
    }
  };
  for (const run of runs) {
    if (!run.items.some((item) => moved.has(item))) continue;
    let fragment: ViewModelNode[] = [];
    let marker = run.markers[0];
    let hadFragment = false;
    const flush = () => {
      if (fragment.length) {
        renumber(fragment, marker);
        hadFragment = true;
      }
      fragment = [];
    };
    run.items.forEach((item, index) => {
      if (item[viewModel].parent !== run.parent) {
        flush();
      } else {
        if (!fragment.length && hadFragment) {
          marker = run.markers[index];
        }
        fragment.push(item);
      }
    });
    flush();
  }
  // A move within one list keeps the parent, so detect a changed run order too.
  for (const run of runs) {
    if (run.items.some((item) => moved.has(item))) continue;
    const current = ((run.parent.children ?? []) as ViewModelNode[]).filter((item) =>
      run.items.includes(item),
    );
    if (current.some((item, index) => item !== run.items[index])) {
      renumber(current, run.markers[0]);
    }
  }
  const destinations = new Set([...moved].map((item) => item[viewModel].parent));
  for (const parent of destinations) {
    if (parent?.type !== 'list') continue;
    const children = parent.children ?? [];
    for (let i = 0; i < children.length; i++) {
      if (!moved.has(children[i])) continue;
      const batch: ViewModelNode[] = [];
      while (i < children.length && moved.has(children[i])) batch.push(children[i++]);
      renumberInsertedItems(batch);
      i--;
    }
  }
}
