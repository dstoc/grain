import type { Affinity, NativeId, NodeId, ProjectionAddress, TapeId } from '../contracts.js';
import type { BlockPlacement } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import type { PublishedProjection } from '../ingest/publication.js';
import type { projectMarkdown } from '../projection/project.js';
import type { ViewNode } from '../projection/types.js';
import { resolveAddress, textPoint } from '../projection/addresses.js';
import type { TextPoint } from '../projection/addresses.js';

export type HistoryPublication = PublishedProjection<ReturnType<typeof projectMarkdown>>;
interface GapBound {
  readonly tape: TapeId;
  readonly native: NativeId;
  readonly after: boolean;
}
export interface StablePoint extends TextPoint {
  readonly affinity: Affinity;
  readonly gap: { readonly left: GapBound; readonly right: GapBound };
  readonly host: Extract<ProjectionAddress, { type: 'node' }>;
  readonly inline: Extract<ProjectionAddress, { type: 'node' }>;
  readonly placement: BlockPlacement | null;
}
export interface StableSelection {
  readonly anchor: StablePoint;
  readonly focus: StablePoint;
  readonly blocks?: readonly ProjectionAddress[];
}
export interface ResolvedPoint {
  readonly origin: Extract<ProjectionAddress, { type: 'node' }>;
  readonly offset: number;
  readonly affinity: Affinity;
}
export type SelectionRestoration =
  | { readonly state: 'unavailable' }
  | { readonly state: 'empty-root'; readonly address: ProjectionAddress }
  | {
      readonly state: 'exact';
      readonly anchor: ResolvedPoint;
      readonly focus: ResolvedPoint;
      readonly blocks?: readonly ProjectionAddress[];
    }
  | {
      readonly state: 'fallback';
      readonly reason: 'incomplete-selection' | 'nearest-visible' | 'empty-root-became-nonempty';
      readonly anchor: ResolvedPoint;
      readonly focus: ResolvedPoint;
    };

export function viewNodes(root: ViewNode): readonly ViewNode[] {
  return [root, ...root.children.flatMap(viewNodes)];
}
const same = (a: NodeId, b: NodeId) => resourceKey(a) === resourceKey(b);
export function projectedNode(root: ViewNode, id: NodeId): ViewNode | undefined {
  return viewNodes(root).find((n) => n.origin.constituents.some((c) => same(c, id)));
}
function editable(node: ViewNode): boolean {
  return node.boundaries.length > 0;
}

/** Capture caller affinity before lowering; TextPoint.side is a different contract. */
export function capturePoint(
  p: HistoryPublication,
  node: ViewNode,
  offset: number,
  affinity: Affinity,
  host: ViewNode = p.value.view.root,
): StablePoint {
  const point = textPoint(node, offset, affinity);
  const neighbor = (side: Affinity): GapBound => {
    const candidate = textPoint(node, offset, side);
    if (candidate.native && (side === 'left' ? offset > 0 : offset < node.content.length))
      return {
        tape: candidate.address.origin.tape,
        native: candidate.native,
        after: candidate.side === 'right',
      };
    // At an edge keep a permanent bound, not the adjacent character returned
    // by textPoint for both affinities. Internal markers may lie between bounds.
    const boundaries = node.boundaries.filter((b) => b.offset === offset);
    const boundary = side === 'left' ? boundaries[0] : boundaries.at(-1);
    const markerId =
      boundary?.address.slot.boundary ??
      (side === 'left' ? candidate.address.origin.start : candidate.address.origin.end);
    const marker = p.native.marker(markerId);
    return { tape: marker.tape, native: marker.native, after: side === 'left' };
  };
  return structuredClone({
    ...point,
    affinity,
    gap: { left: neighbor('left'), right: neighbor('right') },
    host: host.origin,
    inline: node.origin,
    placement: p.value.ownership.blockPlacement(node.origin.representative),
  });
}

function inHost(p: HistoryPublication, host: ProjectionAddress): ViewNode | undefined {
  if (
    host.type !== 'node' ||
    resolveAddress(host, p.value.ownership, p.value.visibility).state !== 'available'
  )
    return undefined;
  const node = projectedNode(p.value.view.root, host.representative);
  return node && host.constituents.every((id) => node.origin.constituents.some((c) => same(c, id)))
    ? node
    : undefined;
}

/** Resolve a retained gap through current fragments, including hidden neighbors and transfers. */
function resolvePoint(
  p: HistoryPublication,
  saved: StablePoint,
  host: ViewNode,
): ResolvedPoint | undefined {
  if (resolveAddress(saved.address, p.value.ownership, p.value.visibility).state !== 'available')
    return undefined;
  const bound = saved.gap[saved.affinity];
  const index = p.native.locate(bound.tape, bound.native);
  const snapshot = p.native.snapshot(bound.tape);
  const part = snapshot.parts.find(
    (part) =>
      part.native.client === bound.native.client &&
      bound.native.clock >= part.native.clock &&
      bound.native.clock < part.native.clock + (part.type === 'text' ? part.text.length : 1),
  );
  if (!part) return undefined;
  const width =
    part.type === 'text'
      ? part.text.codePointAt(bound.native.clock - part.native.clock)! > 0xffff
        ? 2
        : 1
      : 1;
  const at = index + (bound.after ? width : 0);
  // The chosen bound chooses the seam's side before any projection normalization.
  let owner: NodeId;
  let lineage = saved.address.slot.run;
  if (part.type === 'text') {
    const assignment = p.value.ownership.owner({ tape: bound.tape, native: bound.native });
    const run = p.value.ownership.runLayouts.find(
      (r) => resourceKey(r.run) === resourceKey(assignment.run),
    )!;
    owner = p.value.ownership.flowBlock(run.flow);
    lineage = assignment.run;
  } else {
    const resolved = p.value.ownership.resolveSlot(saved.address.slot);
    owner = p.value.ownership.flowBlock(resolved.run.flow);
  }
  const nodes = viewNodes(host);
  let node = nodes.find((n) => n.origin.constituents.some((id) => same(id, owner)));
  // Joined/normalized nodes may retain the source fragments without its header.
  node ??= nodes.find((n) =>
    n.fragments.some(
      (f) =>
        resourceKey(f.range.tape) === resourceKey(bound.tape) &&
        f.range.client === bound.native.client &&
        bound.native.clock >= f.range.clock &&
        bound.native.clock < f.range.clock + f.range.length,
    ),
  );
  if (!node || !editable(node)) return undefined;
  let offset = 0;
  const candidates: { start: number; end: number; offset: number; length: number }[] = [];
  for (const fragment of node.fragments) {
    if (!fragment.visible) continue;
    if (resourceKey(fragment.range.tape) === resourceKey(bound.tape)) {
      const start = p.native.locate(fragment.range.tape, {
        client: fragment.range.client,
        clock: fragment.range.clock,
      });
      // A visible neighbor gives an exact projection position even when an
      // unrelated tape follows it in a joined/transferred inline.
      if (
        fragment.range.client === bound.native.client &&
        bound.native.clock >= fragment.range.clock &&
        bound.native.clock < fragment.range.clock + fragment.range.length
      )
        return {
          origin: structuredClone(node.origin),
          offset: offset + bound.native.clock - fragment.range.clock + (bound.after ? width : 0),
          affinity: saved.affinity,
        };
      if (resourceKey(fragment.address.slot.run) !== resourceKey(lineage)) {
        offset += fragment.text.length;
        continue;
      }
      candidates.push({
        start,
        end: start + fragment.text.length,
        offset,
        length: fragment.text.length,
      });
    }
    offset += fragment.text.length;
  }
  const neighbor =
    saved.affinity === 'left'
      ? candidates.filter((c) => c.end <= at).sort((a, b) => b.end - a.end)[0]
      : candidates.filter((c) => c.start >= at).sort((a, b) => a.start - b.start)[0];
  if (neighbor)
    return {
      origin: structuredClone(node.origin),
      offset: neighbor.offset + (saved.affinity === 'left' ? neighbor.length : 0),
      affinity: saved.affinity,
    };
  const edges = node.boundaries.filter(
    (b) => resourceKey(b.address.slot.run) === resourceKey(lineage),
  );
  const edge = saved.affinity === 'left' ? edges[0] : edges.at(-1);
  return {
    origin: structuredClone(node.origin),
    offset: edge?.offset ?? (saved.affinity === 'left' ? 0 : node.content.length),
    affinity: saved.affinity,
  };
}

function nearest(p: HistoryPublication, saved: StablePoint, host: ViewNode): SelectionRestoration {
  const ownership = p.value.ownership;
  const allowed = new Map(
    viewNodes(host)
      .filter(editable)
      .flatMap((n) => n.origin.constituents.map((id) => [resourceKey(id), n] as const)),
  );
  const raw: { id?: NodeId; gap?: boolean }[] = [];
  const visited = new Set<string>();
  const focusId = saved.inline.representative;
  const inside = (id: NodeId): boolean => {
    let current: NodeId | undefined = id;
    const seen = new Set<string>();
    while (current && !seen.has(resourceKey(current))) {
      if (host.origin.constituents.some((c) => same(c, current!))) return true;
      seen.add(resourceKey(current));
      current = ownership.blockPlacement(current)?.slot.parent;
    }
    return false;
  };
  const movedOutside = !inside(focusId);
  const walk = (id: NodeId) => {
    if (visited.has(resourceKey(id))) return;
    visited.add(resourceKey(id));
    const allocation = ownership.nodeAllocations.find((n) => same(n.id, id));
    if (allocation?.role === 'inline') raw.push({ id });
    for (const occurrence of ownership.occurrenceOrder({ parent: id, predecessor: null })) {
      if (
        movedOutside &&
        saved.placement &&
        resourceKey(occurrence.id) === resourceKey(saved.placement.occurrence)
      )
        raw.push({ gap: true });
      for (const child of ownership.children(id)) {
        const placement = ownership.blockPlacement(child);
        if (placement && resourceKey(placement.occurrence) === resourceKey(occurrence.id))
          walk(child);
      }
    }
  };
  for (const constituent of host.origin.constituents) walk(constituent);
  const index = raw.findIndex((entry) =>
    movedOutside
      ? entry.gap
      : entry.id && saved.inline.constituents.some((id) => same(id, entry.id!)),
  );
  if (index < 0) return { state: 'unavailable' };
  for (let distance = 0; distance < raw.length; distance++) {
    for (const predecessor of [true, false]) {
      const entry = raw[index + (predecessor ? -distance : distance)];
      const node = entry?.id && allowed.get(resourceKey(entry.id));
      if (!node) continue;
      const point: ResolvedPoint = {
        origin: structuredClone(node.origin),
        offset: predecessor ? node.content.length : 0,
        affinity: predecessor ? 'left' : 'right',
      };
      return { state: 'fallback', reason: 'nearest-visible', anchor: point, focus: point };
    }
  }
  return p.value.view.emptyRoot &&
    same(host.origin.representative, p.value.view.root.origin.representative)
    ? { state: 'empty-root', address: structuredClone(p.value.view.emptyRoot) }
    : { state: 'unavailable' };
}

/** Pure caret restoration. It never changes mutation-address availability or canonical facts. */
export function resolveSelection(
  p: HistoryPublication,
  selection: StableSelection | undefined,
  initiatingHost: ProjectionAddress = p.value.view.root.origin,
  emptyRoot = false,
): SelectionRestoration {
  const host = inHost(p, initiatingHost);
  if (!host) return { state: 'unavailable' };
  if (!selection) {
    if (!emptyRoot || !same(host.origin.representative, p.value.view.root.origin.representative))
      return { state: 'unavailable' };
    const first = viewNodes(host).find(editable);
    if (first) {
      const point = {
        origin: structuredClone(first.origin),
        offset: 0,
        affinity: 'right' as const,
      };
      return {
        state: 'fallback',
        reason: 'empty-root-became-nonempty',
        anchor: point,
        focus: point,
      };
    }
    return p.value.view.emptyRoot
      ? { state: 'empty-root', address: structuredClone(p.value.view.emptyRoot) }
      : { state: 'unavailable' };
  }
  if (
    [selection.anchor, selection.focus].some(
      (point) =>
        !same(point.host.representative, host.origin.representative) ||
        point.host.constituents.length !== host.origin.constituents.length ||
        point.host.constituents.some((id) => !host.origin.constituents.some((c) => same(id, c))),
    )
  )
    return { state: 'unavailable' };
  const anchor = resolvePoint(p, selection.anchor, host),
    focus = resolvePoint(p, selection.focus, host);
  const blocks = selection.blocks;
  const hostNodes = viewNodes(host);
  const complete =
    !blocks ||
    blocks.every(
      (address) =>
        address.type === 'node' &&
        resolveAddress(address, p.value.ownership, p.value.visibility).state === 'available' &&
        address.constituents.every((id) =>
          hostNodes.some((n) => n.origin.constituents.some((c) => same(c, id))),
        ),
    );
  if (anchor && focus && complete)
    return structuredClone({ state: 'exact', anchor, focus, ...(blocks ? { blocks } : {}) });
  if (focus)
    return structuredClone({
      state: 'fallback',
      reason: 'incomplete-selection',
      anchor: focus,
      focus,
    });
  return nearest(p, selection.focus, host);
}

/** Compare resolved stable positions, never projection-local construction handles. */
export function collapsedAt(
  p: HistoryPublication,
  previous: StableSelection | undefined,
  next: StableSelection | undefined,
): boolean {
  if (!previous || !next || previous.blocks || next.blocks) return false;
  if (resourceKey(previous.focus.address.slot.run) !== resourceKey(next.focus.address.slot.run))
    return false;
  const host = inHost(p, next.focus.host);
  if (!host || !same(previous.focus.host.representative, next.focus.host.representative))
    return false;
  const points = [previous.anchor, previous.focus, next.anchor, next.focus].map((point) =>
    resolvePoint(p, point, host),
  );
  return points.every(
    (point) =>
      point &&
      points[0] &&
      same(point.origin.representative, points[0].origin.representative) &&
      point.offset === points[0].offset,
  );
}
