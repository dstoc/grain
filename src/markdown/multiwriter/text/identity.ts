import { actorId, assertCounter } from '../contracts.js';
import type { NativeId, ResourceId, ResourceKind } from '../contracts.js';

/** Private cache names, not an alternative envelope encoding. */
export function resourceKey<K extends ResourceKind>(id: ResourceId<K>): string {
  if (!id || !Number.isSafeInteger(id.ordinal) || id.ordinal < 0)
    throw new Error('Invalid resource ordinal');
  const birth = id.birth;
  if (birth.type === 'genesis') {
    if (typeof birth.genesisId !== 'string' || !birth.genesisId)
      throw new Error('Invalid genesis ID');
    return JSON.stringify([id.kind, 'genesis', birth.genesisId, id.ordinal]);
  }
  if (birth.type !== 'action') throw new Error('Invalid resource birth');
  actorId(birth.action.actor);
  assertCounter(birth.action.sequence);
  return JSON.stringify([
    id.kind,
    birth.action.actor,
    birth.action.sequence.toString(),
    id.ordinal,
  ]);
}
export function nativeKey(id: NativeId): string {
  return `${id.client}:${id.clock}`;
}
export function assertNative(id: NativeId, length = 1): void {
  if (
    !Number.isSafeInteger(id.client) ||
    id.client < 0 ||
    id.client > 0xffffffff ||
    !Number.isSafeInteger(id.clock) ||
    id.clock < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    !Number.isSafeInteger(id.clock + length)
  )
    throw new Error('Invalid native ID/range');
}
export function assertUnicode(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error('Native text contains an unpaired surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new Error('Native text contains an unpaired surrogate');
  }
}
export function assertTextBoundary(text: string, offset: number): void {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    throw new Error('Native offset splits a surrogate pair');
}
