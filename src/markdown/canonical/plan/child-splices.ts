import type { NodeId } from '../../semantic/types.js';

export interface ChildSplice {
  readonly index: number;
  readonly removedIds: readonly NodeId[];
  readonly insertedIds: readonly NodeId[];
}

export function diffChildSplices(
  before: readonly NodeId[],
  after: readonly NodeId[],
): readonly ChildSplice[] {
  const destination = new Map(after.map((id, index) => [id, index]));
  const candidates: { readonly beforeIndex: number; readonly afterIndex: number }[] = [];
  before.forEach((id, beforeIndex) => {
    const afterIndex = destination.get(id);
    if (afterIndex !== undefined) candidates.push({ beforeIndex, afterIndex });
  });

  const tails: number[] = [];
  const tailsAt: number[] = [];
  const previous = Array.from({ length: candidates.length }, () => -1);
  for (let index = 0; index < candidates.length; index++) {
    const value = candidates[index]!.afterIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle]! < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tailsAt[low - 1]!;
    tails[low] = value;
    tailsAt[low] = index;
  }

  const matches: { readonly beforeIndex: number; readonly afterIndex: number }[] = [];
  let cursor = tailsAt.at(-1) ?? -1;
  while (cursor >= 0) {
    matches.push(candidates[cursor]!);
    cursor = previous[cursor]!;
  }
  matches.reverse();

  const splices: ChildSplice[] = [];
  let beforeCursor = 0;
  let afterCursor = 0;
  let liveIndex = 0;
  for (const match of matches) {
    const removedIds = before.slice(beforeCursor, match.beforeIndex);
    const insertedIds = after.slice(afterCursor, match.afterIndex);
    if (removedIds.length || insertedIds.length) {
      splices.push(
        Object.freeze({
          index: liveIndex,
          removedIds: Object.freeze([...removedIds]),
          insertedIds: Object.freeze([...insertedIds]),
        }),
      );
      liveIndex += insertedIds.length;
    }
    liveIndex++;
    beforeCursor = match.beforeIndex + 1;
    afterCursor = match.afterIndex + 1;
  }
  const removedIds = before.slice(beforeCursor);
  const insertedIds = after.slice(afterCursor);
  if (removedIds.length || insertedIds.length) {
    splices.push(
      Object.freeze({
        index: liveIndex,
        removedIds: Object.freeze([...removedIds]),
        insertedIds: Object.freeze([...insertedIds]),
      }),
    );
  }
  return Object.freeze(splices);
}
