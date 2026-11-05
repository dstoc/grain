import type { NodeId as OriginId } from '../contracts.js';
import type { ViewNode } from '../projection/types.js';
import { resourceKey } from '../layout/index.js';
import type { NodeId } from '../../semantic/types.js';

export type OriginMap = Pick<
  ReadonlyMap<NodeId, ViewNode>,
  'get' | 'has' | 'keys' | typeof Symbol.iterator
>;
export interface CommandViewIndex {
  readonly origins: OriginMap;
  readonly parents: ReadonlyMap<NodeId, NodeId>;
  readonly siblings: ReadonlyMap<NodeId, { readonly previous?: NodeId; readonly next?: NodeId }>;
  handle(view: ViewNode): NodeId | undefined;
  handleOrigin(id: OriginId): NodeId | undefined;
}
const indexes = new WeakMap<ViewNode, CommandViewIndex>();
/** Publication-local handles preserve the existing preorder contract. Structural
 * changes construct a fresh index; text projections replace only changed records.
 */
export function registerCommandViewIndex(root: ViewNode, index: CommandViewIndex): void {
  indexes.set(root, index);
}
export function commandViewIndex(root: ViewNode): CommandViewIndex {
  const cached = indexes.get(root);
  if (cached) return cached;
  const origins = new Map<NodeId, ViewNode>(),
    byOrigin = new Map<string, NodeId>();
  const parents = new Map<NodeId, NodeId>(),
    siblings = new Map<NodeId, { previous?: NodeId; next?: NodeId }>();
  let ordinal = 0;
  const visit = (view: ViewNode, parent?: NodeId) => {
    const id = `construction:${ordinal++}`;
    origins.set(id, view);
    byOrigin.set(resourceKey(view.origin.representative), id);
    if (parent) parents.set(id, parent);
    for (const child of view.children) visit(child, id);
    view.children.forEach((child, i) =>
      siblings.set(byOrigin.get(resourceKey(child.origin.representative))!, {
        previous:
          i > 0 ? byOrigin.get(resourceKey(view.children[i - 1].origin.representative)) : undefined,
        next:
          i + 1 < view.children.length
            ? byOrigin.get(resourceKey(view.children[i + 1].origin.representative))
            : undefined,
      }),
    );
  };
  visit(root);
  const index = {
    origins,
    parents,
    siblings,
    handle: (view: ViewNode) => byOrigin.get(resourceKey(view.origin.representative)),
    handleOrigin: (id: OriginId) => byOrigin.get(resourceKey(id)),
  };
  indexes.set(root, index);
  return index;
}
