import { countWork } from '../diagnostics.js';
import type { MarkerId, NativeId, RangeRef, TapeId } from '../contracts.js';
import type { TapePart, TapeSnapshot } from '../text/types.js';
import {
  assertNative,
  assertTextBoundary,
  NativeValidationError,
  resourceKey,
} from '../text/identity.js';
import { get, set, remove } from './map.js';
import type { MapRoot } from './map.js';

interface Root {
  readonly key: string;
  readonly part: TapePart;
  readonly left?: Root;
  readonly right?: Root;
  readonly height: number;
  readonly length: number;
  readonly firstMarker?: MarkerId;
  readonly lastMarker?: MarkerId;
}
export interface NativeTapeWork {
  nativeIndexNodesCopied: number;
  nativePositionNodesVisited: number;
  rangeIndexNodesVisited: number;
  rangePartsVisited: number;
  snapshotsExported: number;
  snapshotPartsExported: number;
}
const length = (root: Root | undefined) => root?.length ?? 0;
const height = (root: Root | undefined) => root?.height ?? 0;
const size = (part: TapePart) => (part.type === 'text' ? part.text.length : 1);
const nativeKey = (id: NativeId) =>
  `${String(id.client).padStart(10, '0')}:${String(id.clock).padStart(16, '0')}`;

/** Immutable insertion-only tape roots. Native identities name nodes; a separate
 * persistent parent index resolves positions without rewriting later offsets.
 * No generated order labels or Yjs objects enter a publication.
 */
export class NativeTapeIndex {
  private root?: Root;
  private nodes?: MapRoot<Root>;
  private parents?: MapRoot<string | null>;
  private markers?: MapRoot<string>;
  constructor(
    parts: readonly TapePart[],
    private readonly work: NativeTapeWork,
  ) {
    countWork('nativeTape.indexesConstructed');
    countWork('nativeTape.partsInput', parts.length);
    let offset = 0;
    for (const part of parts) {
      if (part.index !== offset || !size(part)) throw new Error('Invalid native tape parts');
      offset += size(part);
    }
    const build = (start: number, end: number): Root | undefined => {
      if (start === end) return undefined;
      const mid = (start + end) >>> 1;
      return this.node({ ...parts[mid], index: 0 }, build(start, mid), build(mid + 1, end));
    };
    this.root = build(0, parts.length);
    if (this.root) this.parents = set(this.parents, this.root.key, null);
  }
  private fork(): NativeTapeIndex {
    const copy = new NativeTapeIndex([], this.work);
    copy.root = this.root;
    copy.nodes = this.nodes;
    copy.parents = this.parents;
    copy.markers = this.markers;
    return copy;
  }
  private node(part: TapePart, left?: Root, right?: Root): Root {
    const key = nativeKey(part.native),
      root: Root = {
        key,
        part,
        left,
        right,
        height: 1 + Math.max(height(left), height(right)),
        length: length(left) + size(part) + length(right),
        firstMarker:
          left?.firstMarker ?? (part.type === 'marker' ? part.marker : right?.firstMarker),
        lastMarker: right?.lastMarker ?? (part.type === 'marker' ? part.marker : left?.lastMarker),
      };
    countWork('nativeTape.nativeIndexNodesCopied');
    this.work.nativeIndexNodesCopied++;
    this.nodes = set(this.nodes, key, root);
    if (left) this.parents = set(this.parents, left.key, key);
    if (right) this.parents = set(this.parents, right.key, key);
    if (part.type === 'marker') this.markers = set(this.markers, resourceKey(part.marker), key);
    return root;
  }
  private balance(part: TapePart, left?: Root, right?: Root): Root {
    if (height(left) - height(right) > 1) {
      const l = left!;
      if (height(l.left) >= height(l.right))
        return this.node(l.part, l.left, this.node(part, l.right, right));
      const pivot = l.right!;
      return this.node(
        pivot.part,
        this.node(l.part, l.left, pivot.left),
        this.node(part, pivot.right, right),
      );
    }
    if (height(right) - height(left) > 1) {
      const r = right!;
      if (height(r.right) >= height(r.left))
        return this.node(r.part, this.node(part, left, r.left), r.right);
      const pivot = r.left!;
      return this.node(
        pivot.part,
        this.node(part, left, pivot.left),
        this.node(r.part, pivot.right, r.right),
      );
    }
    return this.node(part, left, right);
  }
  private join(left: Root | undefined, part: TapePart, right: Root | undefined): Root {
    if (height(left) - height(right) > 1)
      return this.balance(left!.part, left!.left, this.join(left!.right, part, right));
    if (height(right) - height(left) > 1)
      return this.balance(right!.part, this.join(left, part, right!.left), right!.right);
    return this.node(part, left, right);
  }
  private split(root: Root | undefined, at: number): [Root | undefined, Root | undefined] {
    if (!root) {
      if (at !== 0) throw new Error('Native splice outside tape');
      return [undefined, undefined];
    }
    const before = length(root.left),
      end = before + size(root.part);
    if (at < before) {
      const [left, right] = this.split(root.left, at);
      return [left, this.join(right, root.part, root.right)];
    }
    if (at > end) {
      const [left, right] = this.split(root.right, at - end);
      return [this.join(root.left, root.part, left), right];
    }
    if (at === before) return [root.left, this.join(undefined, root.part, root.right)];
    if (at === end) return [this.join(root.left, root.part, undefined), root.right];
    if (root.part.type !== 'text') throw new Error('Native splice splits a marker');
    const offset = at - before;
    assertTextBoundary(root.part.text, offset);
    return [
      this.join(root.left, { ...root.part, text: root.part.text.slice(0, offset) }, undefined),
      this.join(
        undefined,
        {
          ...root.part,
          native: { ...root.part.native, clock: root.part.native.clock + offset },
          text: root.part.text.slice(offset),
        },
        root.right,
      ),
    ];
  }
  /** Number of retained units in one final integrated item's native interval.
   * The interval can contain new units plus an old prefix merged by Yjs.
   */
  private covered(part: TapePart): number {
    const from = nativeKey(part.native),
      endClock = part.native.clock + size(part),
      end = nativeKey({ client: part.native.client, clock: endClock });
    const visit = (root: MapRoot<Root> | undefined): number => {
      if (!root) return 0;
      const item = root.value.part;
      let count = 0;
      if (root.key >= from && root.key < end && item.native.client === part.native.client)
        count = Math.max(
          0,
          Math.min(endClock, item.native.clock + size(item)) -
            Math.max(part.native.clock, item.native.clock),
        );
      return (
        count + (root.key >= from ? visit(root.left) : 0) + (root.key < end ? visit(root.right) : 0)
      );
    };
    // A start inside an old segment needs its predecessor too. Final integrated
    // parts normally retain that segment's start; the explicit predecessor keeps
    // the operation correct for detached interval controls as well.
    let cursor = this.nodes,
      predecessor: Root | undefined;
    while (cursor) {
      if (cursor.key < from) {
        predecessor = cursor.value;
        cursor = cursor.right;
      } else cursor = cursor.left;
    }
    const old = predecessor?.part;
    const prefix =
      old?.native.client === part.native.client
        ? Math.max(0, Math.min(endClock, old.native.clock + size(old)) - part.native.clock)
        : 0;
    return prefix + visit(this.nodes);
  }
  private drop(root: Root | undefined): void {
    if (!root) return;
    this.drop(root.left);
    this.drop(root.right);
    this.nodes = remove(this.nodes, root.key);
    this.parents = remove(this.parents, root.key);
    if (root.part.type === 'marker')
      this.markers = remove(this.markers, resourceKey(root.part.marker));
  }
  /** Parts are in final tape order. Earlier splices have already installed every
   * insertion before this final index. Existing pieces in this item are replaced,
   * including Yjs merges; unrelated roots and identities remain shared.
   */
  refine(parts: readonly TapePart[]): NativeTapeIndex {
    const copy = this.fork();
    for (const part of parts) {
      const removed = copy.covered(part);
      if (part.index < 0 || part.index + removed > length(copy.root))
        throw new Error('Native splice outside tape');
      const [left, rest] = copy.split(copy.root, part.index),
        [dropped, right] = copy.split(rest, removed);
      copy.drop(dropped);
      copy.root = copy.join(left, { ...part, index: 0 }, right);
      copy.parents = set(copy.parents, copy.root.key, null);
    }
    return copy;
  }
  private partAt(id: NativeId, textBoundary = true): Root {
    assertNative(id);
    const key = nativeKey(id);
    let cursor = this.nodes,
      found: Root | undefined;
    while (cursor) {
      if (cursor.key <= key) {
        found = cursor.value;
        cursor = cursor.right;
      } else cursor = cursor.left;
    }
    if (
      !found ||
      found.part.native.client !== id.client ||
      id.clock >= found.part.native.clock + size(found.part)
    )
      throw new NativeValidationError('Unknown native ID');
    if (textBoundary && found.part.type === 'text')
      assertTextBoundary(found.part.text, id.clock - found.part.native.clock);
    return found;
  }
  private position(root: Root): number {
    let at = length(root.left),
      key = root.key,
      parent = get(this.parents, key);
    while (parent !== null) {
      countWork('nativeTape.nativePositionNodesVisited');
      this.work.nativePositionNodesVisited++;
      if (parent === undefined) throw new Error('Native index lost a parent');
      const above = get(this.nodes, parent)!;
      if (above.right?.key === key) at += length(above.left) + size(above.part);
      else if (above.left?.key !== key) throw new Error('Native index has an invalid parent');
      key = parent;
      parent = get(this.parents, key);
    }
    return at;
  }
  locate(id: NativeId): number {
    const root = this.partAt(id);
    return this.position(root) + id.clock - root.part.native.clock;
  }
  cell(tape: TapeId, id: NativeId): RangeRef {
    // Ownership addresses scalar UTF-16 identities, including the second unit
    // of a surrogate pair. Mutation/range boundaries still use partAt's check.
    const part = this.partAt(id, false);
    if (part.part.type !== 'text') throw new NativeValidationError('Text range includes a marker');
    const at = this.position(part);
    let root = this.root,
      base = 0,
      start: MarkerId | undefined,
      end: MarkerId | undefined;
    while (root) {
      countWork('nativeTape.nativePositionNodesVisited');
      this.work.nativePositionNodesVisited++;
      const index = base + length(root.left);
      if (index <= at) {
        start = root.part.type === 'marker' ? root.part.marker : (root.left?.lastMarker ?? start);
        base = index + size(root.part);
        root = root.right;
      } else {
        end = root.part.type === 'marker' ? root.part.marker : (root.right?.firstMarker ?? end);
        root = root.left;
      }
    }
    if (!start || !end) throw new NativeValidationError('Text outside permanent tape endpoints');
    return { tape, start, end };
  }
  marker(id: MarkerId) {
    const key = get(this.markers, resourceKey(id)),
      root = key && get(this.nodes, key);
    if (!root || root.part.type !== 'marker')
      throw new NativeValidationError('Unknown permanent marker');
    return structuredClone({ ...root.part, index: this.position(root) });
  }
  lookup(id: NativeId): TapePart {
    const root = this.partAt(id);
    return { ...root.part, index: this.position(root) };
  }
  *range(from: number, to: number, count = true): Generator<TapePart> {
    const stack: { readonly root: Root; readonly index: number }[] = [];
    let root = this.root,
      base = 0;
    while (root) {
      if (count) this.work.rangeIndexNodesVisited++;
      const index = base + length(root.left);
      if (index >= from) {
        stack.push({ root, index });
        root = root.left;
      } else {
        base = index + size(root.part);
        root = root.right;
      }
    }
    while (stack.length) {
      const { root, index } = stack.pop()!;
      if (index >= to) return;
      if (count) this.work.rangePartsVisited++;
      yield { ...root.part, index };
      if (index + size(root.part) >= to) return;
      let next = root.right,
        offset = index + size(root.part);
      while (next) {
        stack.push({ root: next, index: offset + length(next.left) });
        next = next.left;
      }
    }
  }
  snapshot(tape: TapeId): TapeSnapshot {
    const parts = [...this.range(0, Infinity, false)];
    countWork('nativeTape.snapshotsExported');
    this.work.snapshotsExported++;
    this.work.snapshotPartsExported += parts.length;
    return structuredClone({
      tape,
      length: length(this.root),
      parts,
    });
  }
}
