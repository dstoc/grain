import { measure } from '../diagnostics.js';
import { assertTextRange, assertWellFormedText } from '../../semantic/types.js';
import type {
  Affinity,
  BlockSlot,
  NativeId,
  NativeTextRange,
  NodeId,
  ProjectionAddress,
} from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import type { OwnershipResult } from '../ownership/index.js';
import type { NativeView } from '../ingest/publication.js';
import type { Visibility } from '../visibility/index.js';
import { ProjectionError } from './interpretation.js';
import type { ProjectionView, TextFragment, ViewNode } from './types.js';

export interface TextPoint {
  readonly address: Extract<ProjectionAddress, { type: 'text' }>;
  /** A native character neighbor; null means use the permanent marker in address.slot. */
  readonly native: NativeId | null;
  readonly side: Affinity;
}

/** Visible UTF-16 coordinates lower only to exact native identities, never substring search. */
export function selectionRanges(
  node: ViewNode,
  from: number,
  to: number,
): readonly NativeTextRange[] {
  assertTextRange(node.content, from, to, 'Projected selection');
  let offset = 0;
  return node.fragments.flatMap((fragment) => {
    if (!fragment.visible) return [];
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + fragment.text.length);
    const range =
      start < end
        ? [{ ...fragment.range, clock: fragment.range.clock + start - offset, length: end - start }]
        : [];
    offset += fragment.text.length;
    return range;
  });
}

export function textPoint(node: ViewNode, offset: number, affinity: Affinity): TextPoint {
  return measure('selection-address', () => textPointMeasured(node, offset, affinity));
}
function textPointMeasured(node: ViewNode, offset: number, affinity: Affinity): TextPoint {
  assertTextRange(node.content, offset, offset, 'Projected caret');
  const visible: { fragment: TextFragment; start: number; end: number }[] = [];
  let cursor = 0;
  for (const fragment of node.fragments)
    if (fragment.visible) {
      visible.push({ fragment, start: cursor, end: cursor + fragment.text.length });
      cursor += fragment.text.length;
    }
  const left = visible.findLast((entry) => entry.start < offset && offset <= entry.end);
  const right = visible.find((entry) => entry.start <= offset && offset < entry.end);
  const candidate = affinity === 'left' ? (left ?? right) : (right ?? left);
  if (candidate) {
    const { fragment, start, end } = candidate;
    // locate() rejects a low surrogate. Reference the start of the whole previous
    // scalar when inserting after a character, including a surrogate pair.
    const local = offset - start;
    const side = offset === end || (affinity === 'left' && offset > start) ? 'right' : 'left';
    let at = side === 'right' ? local - 1 : local;
    if (side === 'right' && at > 0 && /[\uDC00-\uDFFF]/.test(fragment.text[at]!)) at--;
    return structuredClone({
      address: fragment.address,
      native: { client: fragment.range.client, clock: fragment.range.clock + at },
      side,
    });
  }
  const boundary = affinity === 'left' ? node.boundaries[0] : node.boundaries.at(-1);
  if (!boundary) throw new ProjectionError('Node has no editable text address');
  return structuredClone({
    address: boundary.address,
    native: null,
    side: boundary.address.slot.side,
  });
}

/** Both sides of a merged boundary keep the original constituent's own gap. */
export interface WrapperBoundaryAddress {
  readonly container: NodeId;
  readonly slot: BlockSlot;
}
export function wrapperBoundary(
  node: ViewNode,
  boundary: number,
  side: Affinity,
): WrapperBoundaryAddress {
  if (!Number.isInteger(boundary) || boundary < 0 || boundary > node.wrappers.length)
    throw new ProjectionError('Invalid wrapper boundary');
  const left = node.wrappers[boundary - 1];
  const right = node.wrappers[boundary];
  const wrapper = side === 'left' ? (left ?? right) : (right ?? left);
  if (!wrapper) throw new ProjectionError('Node has no wrapper origins');
  const slot = wrapper === left ? wrapper.end : wrapper.start;
  return structuredClone({ container: wrapper.node, slot });
}

export function deletionTargets(node: ViewNode): readonly NodeId[] {
  return structuredClone(node.origin.constituents);
}

export type AddressResolution =
  | { readonly state: 'available'; readonly address: ProjectionAddress }
  | { readonly state: 'unavailable'; readonly address: ProjectionAddress };
/** Return the captured address unchanged. A stale lineage never redirects to its new owner. */
export function resolveAddress(
  address: ProjectionAddress,
  ownership: OwnershipResult,
  visibility: Visibility,
): AddressResolution {
  return measure('selection-address', () => resolveAddressMeasured(address, ownership, visibility));
}
function resolveAddressMeasured(
  address: ProjectionAddress,
  ownership: OwnershipResult,
  visibility: Visibility,
): AddressResolution {
  const nodes = ownership.nodeAllocations;
  const exists = (id: NodeId) => nodes.some((node) => resourceKey(node.id) === resourceKey(id));
  const available = (id: NodeId) =>
    visibility.nodes.some((node) => resourceKey(node.node) === resourceKey(id) && node.available);
  let valid = false;
  switch (address.type) {
    case 'node':
      valid =
        exists(address.representative) &&
        address.constituents.some(
          (id) => resourceKey(id) === resourceKey(address.representative),
        ) &&
        new Set(address.constituents.map(resourceKey)).size === address.constituents.length &&
        address.constituents.every(available);
      break;
    case 'edge':
    case 'empty-root':
      try {
        ownership.resolveBlockSlot(address.slot);
        valid =
          available(address.slot.parent) &&
          (address.type === 'empty-root' || (exists(address.child) && available(address.child)));
      } catch {
        valid = false;
      }
      break;
    case 'text': {
      try {
        const resolved = ownership.resolveSlot(address.slot);
        const home = nodes.find(
          (node) => node.flow && resourceKey(node.flow) === resourceKey(resolved.run.flow),
        );
        const homeVisibility = visibility.nodes.find(
          (node) => home && resourceKey(node.node) === resourceKey(home.id),
        );
        // Creation undo can suppress the source header while its joined flow
        // survives. Keep that lineage, but reject deleted sources/destinations.
        valid =
          !!homeVisibility &&
          !homeVisibility.deleted &&
          available(ownership.flowBlock(resolved.run.flow)) &&
          ownership.containsBoundary(address.origin, address.slot.boundary);
      } catch {
        valid = false;
      }
      break;
    }
  }
  return { state: valid ? 'available' : 'unavailable', address: structuredClone(address) };
}

export interface EmptyRootRequest {
  readonly type: 'create-paragraph';
  readonly address: Extract<ProjectionAddress, { type: 'empty-root' }>;
  readonly text: string;
}
/** MW-09 supplies IDs, a fresh home, native brackets, publication and history in one action. */
export function requestEmptyRootEdit(view: ProjectionView, text: string): EmptyRootRequest {
  assertWellFormedText(text);
  if (!view.emptyRoot || !text.length)
    throw new ProjectionError('Empty-root edit requires a caret and nonempty text');
  return { type: 'create-paragraph', address: structuredClone(view.emptyRoot), text };
}

/** Exact intra-cell insertion; permanent edge slots are lowered by HomeIndex in MW-04. */
export function nativePointIndex(point: TextPoint, native: NativeView): number | null {
  if (!point.native) return null;
  const tape = point.address.origin.tape;
  const index = native.locate(tape, point.native);
  if (point.side === 'left') return index;
  const snapshot = native.snapshot(tape);
  const part = snapshot.parts.find(
    (part) =>
      part.type === 'text' &&
      part.native.client === point.native!.client &&
      point.native!.clock >= part.native.clock &&
      point.native!.clock < part.native.clock + part.text.length,
  );
  if (!part || part.type !== 'text') throw new ProjectionError('Text neighbor is unavailable');
  const offset = point.native.clock - part.native.clock;
  return index + (part.text.codePointAt(offset)! > 0xffff ? 2 : 1);
}
