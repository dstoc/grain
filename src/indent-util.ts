import { cast } from './asserts.js';
import type { ViewModelNode } from './markdown/view-model-node.js';
import { findAncestor, ancestors } from './markdown/view-model-util.js';
import { viewModel } from './markdown/view-model-node.js';

export function unindent(node: ViewModelNode, root: ViewModelNode) {
  const { ancestor: listItem, path } = findAncestor(node, root, 'list-item');
  if (!listItem || !path) return;
  const target = path[0];
  const nextSibling = listItem[viewModel].nextSibling;
  const list = listItem[viewModel].parent!;
  const targetListItemSibling = list[viewModel].parent!;
  if (targetListItemSibling?.type === 'list-item') {
    listItem[viewModel].insertBefore(
      cast(targetListItemSibling[viewModel].parent),
      targetListItemSibling[viewModel].nextSibling,
    );
  } else {
    target[viewModel].insertBefore(
      cast(list[viewModel].parent),
      list[viewModel].nextSibling,
    );
    listItem[viewModel].remove();
  }
  if (nextSibling) {
    let next: ViewModelNode | undefined = nextSibling;
    while (next) {
      if (listItem[viewModel].lastChild?.type !== 'list') {
        listItem[viewModel].tree
          .add({
            type: 'list',
          })
          [viewModel].insertBefore(listItem);
      }
      const targetList = listItem[viewModel].lastChild!;
      const toMove: ViewModelNode = next;
      next = toMove[viewModel].nextSibling;
      toMove[viewModel].insertBefore(targetList);
    }
  }
  if (listItem.children?.length && !listItem[viewModel].parent) {
    listItem[viewModel].firstChild?.[viewModel].insertBefore(
      cast(target[viewModel].parent),
      target[viewModel].nextSibling,
    );
  }
  if (!list.children?.length) {
    list[viewModel].remove();
  }
}

export function findIndentTarget(node: ViewModelNode, root: ViewModelNode) {
  let target = node;
  for (const ancestor of ancestors(node, root)) {
    if (ancestor.type === 'list-item') break;
    if (ancestor.type === 'document') break;
    if (ancestor.type === 'section') break;
    target = ancestor;
  }
  return target;
}

export function indent(node: ViewModelNode, root: ViewModelNode) {
  const target = findIndentTarget(node, root);
  let listItem: ViewModelNode;
  if (target[viewModel].parent!.type === 'list-item') {
    listItem = target[viewModel].parent!;
  } else {
    listItem = target[viewModel].tree.add({
      type: 'list-item',
      marker: '* ',
    });
    listItem[viewModel].insertBefore(cast(target[viewModel].parent), target);
    target[viewModel].insertBefore(listItem);
  }
  const listItemPreviousSibling = listItem[viewModel].previousSibling;
  if (listItemPreviousSibling?.type === 'list-item') {
    const lastChild = listItemPreviousSibling[viewModel].lastChild;
    if (lastChild?.type === 'list') {
      listItem[viewModel].insertBefore(lastChild);
    } else {
      listItem[viewModel].insertBefore(listItemPreviousSibling);
    }
  } else if (listItemPreviousSibling?.type === 'list') {
    listItem[viewModel].insertBefore(listItemPreviousSibling);
  }
  if (listItem[viewModel].parent!.type !== 'list') {
    const list = target[viewModel].tree.add({
      type: 'list',
    });
    list[viewModel].insertBefore(cast(listItem[viewModel].parent), listItem);
    listItem[viewModel].insertBefore(list);
  }
}
