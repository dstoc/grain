import { countWork } from '../diagnostics.js';
import type { NodeId as OriginId } from '../contracts.js';
import type { NodeId } from '../../semantic/types.js';
import type { ViewNode } from '../projection/types.js';
import type { CommandViewIndex, OriginMap } from '../authoring/view-index.js';
import { resourceKey } from '../layout/index.js';
import { PersistentMap, set, remove } from './map.js';
import type { MapRoot } from './map.js';

interface Child {
  readonly id: string;
  readonly size: number;
}
type Children = MapRoot<Child> | undefined;
interface Record {
  readonly node: ViewNode;
  readonly parent?: string;
  readonly position?: string;
  readonly children: Children;
  readonly size: number;
}
const weights = new WeakMap<object, number>();
function weight(root: Children): number {
  if (!root) return 0;
  let size = weights.get(root);
  if (size === undefined) {
    size = weight(root.left) + root.value.size + weight(root.right);
    weights.set(root, size);
    countWork('command.orderNodesSummarized');
  }
  return size;
}
/** Private fractional positions keep following siblings' keys stable. Generated
 * keys never end in the lower sentinel; both bounds remain strictly outside.
 */
function between(left = '', right?: string): string {
  if (right !== undefined && left >= right) throw new Error('Invalid sibling order bounds');
  let prefix = '';
  for (let i = 0; ; i++) {
    const a = left.charCodeAt(i) || 0,
      b = right !== undefined && i < right.length ? right.charCodeAt(i) : 65535;
    if (b - a > 1) return prefix + String.fromCharCode((a + b) >>> 1);
    prefix += String.fromCharCode(a);
    if (a < b) right = undefined;
  }
}
const idOf = (node: ViewNode) => resourceKey(node.origin.representative);
function before(root: Children, position: string): number {
  let result = 0;
  while (root) {
    countWork('command.orderNodesRead');
    if (position <= root.key) root = root.left;
    else {
      result += weight(root.left) + root.value.size;
      root = root.right;
    }
  }
  return result;
}
function at(root: Children, ordinal: number): { id: string; offset: number } | undefined {
  while (root) {
    countWork('command.orderNodesRead');
    const left = weight(root.left);
    if (ordinal < left) root = root.left;
    else if (ordinal < left + root.value.size) return { id: root.value.id, offset: ordinal - left };
    else {
      ordinal -= left + root.value.size;
      root = root.right;
    }
  }
}
function neighbor(root: Children, position: string, previous: boolean): string | undefined {
  let result: string | undefined;
  while (root) {
    countWork('command.orderNodesRead');
    if (previous ? root.key < position : root.key > position) {
      result = root.value.id;
      root = previous ? root.right : root.left;
    } else root = previous ? root.left : root.right;
  }
  return result;
}
function* children(root: Children): Generator<Child> {
  if (!root) return;
  yield* children(root.left);
  yield root.value;
  yield* children(root.right);
}

/** Publication-local preorder ordinals over persistent origin records and
 * weighted sibling trees. Selected reads do not enumerate/build a handle map.
 * Refinement visits changed records and copies changed parents' child sequences;
 * unchanged subtrees retain both their records and ordering roots.
 */
export class IndexedCommandView implements CommandViewIndex {
  private constructor(
    private readonly root: string,
    private readonly records: PersistentMap<Record>,
  ) {}
  static create(root: ViewNode): IndexedCommandView {
    countWork('command.fullIndexesConstructed');
    return new IndexedCommandView(idOf(root), new PersistentMap()).refine(root);
  }
  /** Shape-preserving text/property replacement. The projection caller has
   * already retained every child identity/order and every parent edge. Weighted
   * sibling roots stay unchanged; only the supplied immutable records change.
   */
  replaceRecords(changed: Iterable<ViewNode>): IndexedCommandView {
    const records = this.records.fork();
    for (const node of changed) {
      const id = idOf(node),
        prior = records.get(id);
      if (!prior || prior.node.children.length !== node.children.length)
        throw new Error('Command content replacement changed structure');
      if (prior.node !== node) {
        records.set(id, { ...prior, node });
        countWork('command.viewRecordsIndexed');
      }
    }
    return new IndexedCommandView(this.root, records);
  }
  refine(root: ViewNode): IndexedCommandView {
    if (idOf(root) !== this.root) throw new Error('Command root identity changed');
    const records = this.records.fork(),
      visited = new Set<string>(),
      removed = new Set<string>();
    const visit = (node: ViewNode, parent?: string, position?: string): number => {
      const id = idOf(node),
        prior = records.get(id);
      if (visited.has(id)) throw new Error('Duplicate command view origin');
      visited.add(id);
      if (prior?.node === node) {
        if (prior.parent !== parent || prior.position !== position)
          records.set(id, { ...prior, parent, position });
        return prior.size;
      }
      countWork('command.viewRecordsIndexed');
      let order = prior?.children;
      const old = prior?.node.children ?? [],
        next = node.children;
      countWork('command.childArrayEntriesInspected', old.length + next.length);
      let prefix = 0,
        suffix = 0;
      while (
        prefix < old.length &&
        prefix < next.length &&
        idOf(old[prefix]) === idOf(next[prefix])
      )
        prefix++;
      while (
        suffix < old.length - prefix &&
        suffix < next.length - prefix &&
        idOf(old[old.length - suffix - 1]) === idOf(next[next.length - suffix - 1])
      )
        suffix++;
      for (let i = prefix; i < old.length - suffix; i++) {
        const child = idOf(old[i]),
          key = records.get(child)!.position!;
        order = remove(order, key);
        removed.add(child);
      }
      let left = prefix ? records.get(idOf(next[prefix - 1]))!.position : undefined;
      const right = suffix ? records.get(idOf(old[old.length - suffix]))!.position : undefined;
      for (let i = 0; i < next.length; i++) {
        const child = next[i],
          childId = idOf(child);
        const key =
          i < prefix || i >= next.length - suffix
            ? records.get(childId)!.position!
            : between(left, right);
        const size = visit(child, id, key);
        const previous = records.get(childId);
        // set() shares its path when the weighted child is unchanged.
        const oldChild = prior && this.records.get(childId);
        if (
          (i >= prefix && i < next.length - suffix) ||
          !oldChild ||
          oldChild.parent !== id ||
          oldChild.position !== key ||
          oldChild.size !== size
        )
          order = set(order, key, { id: childId, size });
        else if (!previous) throw new Error('Missing child record');
        left = key;
      }
      const size = 1 + weight(order);
      records.set(id, { node, parent, position, children: order, size });
      return size;
    };
    visit(root);
    const forget = (id: string) => {
      if (visited.has(id)) return;
      const record = records.get(id);
      if (!record) return;
      for (const child of children(record.children)) forget(child.id);
      records.delete(id);
      countWork('command.viewRecordsRemoved');
    };
    for (const id of removed) forget(id);
    return new IndexedCommandView(this.root, records);
  }
  private select(handle: NodeId): Record | undefined {
    countWork('command.rankSelectQueries');
    const match = /^construction:(0|[1-9]\d*)$/.exec(handle);
    if (!match) return undefined;
    let ordinal = Number(match[1]),
      record = this.records.get(this.root);
    if (!Number.isSafeInteger(ordinal) || !record || ordinal >= record.size) return undefined;
    while (ordinal) {
      const child = at(record.children, ordinal - 1);
      if (!child) return undefined;
      record = this.records.get(child.id)!;
      ordinal = child.offset;
    }
    return record;
  }
  private rank(id: string): NodeId | undefined {
    countWork('command.rankSelectQueries');
    const initial = this.records.get(id);
    if (!initial) return undefined;
    let record: Record = initial,
      rank = 0;
    while (record.parent) {
      const parent: Record = this.records.get(record.parent)!;
      rank += 1 + before(parent.children, record.position!);
      record = parent;
    }
    return `construction:${rank}`;
  }
  readonly origins: OriginMap = {
    get: (id) => this.select(id)?.node,
    has: (id) => !!this.select(id),
    keys: () => this.keys(),
    [Symbol.iterator]: () => this.entries(),
  };
  private *entries(): Generator<[NodeId, ViewNode]> {
    let ordinal = 0;
    const visit = function* (records: PersistentMap<Record>, id: string): Generator<ViewNode> {
      const record = records.get(id)!;
      yield record.node;
      for (const child of children(record.children)) yield* visit(records, child.id);
    };
    for (const node of visit(this.records, this.root)) {
      countWork('command.explicitRecordsEnumerated');
      yield [`construction:${ordinal++}`, node];
    }
  }
  private *keys(): Generator<NodeId> {
    for (const [id] of this.entries()) yield id;
  }
  readonly parents = {
    get: (handle: NodeId) => {
      const record = this.select(handle);
      return record?.parent ? this.rank(record.parent) : undefined;
    },
  };
  readonly siblings = {
    get: (handle: NodeId) => {
      const record = this.select(handle);
      if (!record?.parent) return undefined;
      const parent = this.records.get(record.parent)!;
      const previous = neighbor(parent.children, record.position!, true),
        next = neighbor(parent.children, record.position!, false);
      return {
        previous: previous ? this.rank(previous) : undefined,
        next: next ? this.rank(next) : undefined,
      };
    },
  };
  handle(view: ViewNode): NodeId | undefined {
    return this.rank(idOf(view));
  }
  handleOrigin(id: OriginId): NodeId | undefined {
    return this.rank(resourceKey(id));
  }
}
