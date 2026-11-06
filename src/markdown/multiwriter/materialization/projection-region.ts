import type { NodeId, RunId } from '../contracts.js';
import type { OwnershipResult } from '../ownership/ownership.js';
import type { Interpretations } from '../projection/interpretation.js';
import type { ViewNode } from '../projection/types.js';
import type { NodeVisibility } from '../visibility/visibility.js';
import { rawProjectionNode, projectedNodeType } from '../projection/raw-node.js';
import { normalizeProjection } from '../projection/normalize.js';
import { isAllowedSemanticChild } from '../../semantic/types.js';
import { resourceKey } from '../layout/index.js';
import { countWork, touchWork } from '../diagnostics.js';
import { PersistentMap } from './map.js';

const key = (node: ViewNode) => resourceKey(node.origin.representative);
interface Boundary {
  readonly node: NodeId;
  readonly type: ViewNode['type'];
  /** A projected header/content witness remains after empty-container cleanup. */
  readonly survives: boolean;
}
export interface NormalizationDependencies {
  readonly inputs: PersistentMap<readonly string[]>;
  readonly outputs: PersistentMap<readonly string[]>;
  readonly boundaries: PersistentMap<readonly Boundary[]>;
}
const wrapper = (type: ViewNode['type']) => type === 'list' || type === 'block-quote';
/** Boundary facts describe raw projection before the shared pass. In particular,
 * available empty wrappers remain merge barriers until its cleanup stage. */
function summarizeBoundary(
  node: NodeId,
  ownership: OwnershipResult,
  interpretations: Interpretations,
  visibility: RegionInput['visibility'],
): readonly Boundary[] {
  countWork('projection.normalizationBoundaryNodesInspected');
  touchWork('projection.normalizationBoundaryNodes', resourceKey(node));
  if (!visibility.get(resourceKey(node))?.available) return [];
  const allocation = ownership.nodeAllocation(node),
    type = projectedNodeType(allocation, interpretations.properties(node)),
    children = ownership
      .children(node)
      .flatMap((child) => summarizeBoundary(child, ownership, interpretations, visibility));
  if (allocation.flow && resourceKey(ownership.flowBlock(allocation.flow)) !== resourceKey(node))
    return children;
  return [
    {
      node,
      type,
      survives:
        !['list', 'list-item', 'block-quote'].includes(type) || children.some((c) => c.survives),
    },
    ...(['paragraph', 'code-block'].includes(type) ? children : []),
  ];
}
/** Raw top-level input of an origin, independent of normalized placement. */
function top(node: NodeId, ownership: OwnershipResult, root: string): string | undefined {
  const seen = new Set<string>();
  for (let current = node; ;) {
    const id = resourceKey(current),
      parent = ownership.blockPlacement(current)?.slot.parent;
    if (seen.has(id)) throw new Error('Raw normalization placement contains a cycle');
    seen.add(id);
    countWork('projection.normalizationAncestorEdgesVisited');
    if (!parent) return undefined;
    if (resourceKey(parent) === root) return id;
    current = parent;
  }
}
function normalizationInputs(
  node: ViewNode,
  ownership: OwnershipResult,
  root: string,
  ids: readonly string[],
  positions: ReadonlyMap<string, number>,
): readonly string[] {
  const inputs = new Set<string>();
  const visit = (value: ViewNode) => {
    countWork('projection.normalizationOriginsInspected');
    for (const origin of value.origin.constituents) {
      const input = top(origin, ownership, root);
      if (input) inputs.add(input);
    }
    for (const child of value.children) visit(child);
  };
  visit(node);
  // A cleaned/invisible gap can separate origin contributors. Changes there
  // must also retract the former output, even when the gap has no own origin.
  const members = [...inputs].map((id) => positions.get(id)!);
  if (members.length)
    for (let i = Math.min(...members); i <= Math.max(...members); i++) {
      inputs.add(ids[i]);
      countWork('projection.normalizationGapEntriesIndexed');
    }
  return [...inputs];
}
export function indexNormalization(
  root: ViewNode,
  ownership: OwnershipResult,
  interpretations: Interpretations,
  visibility: RegionInput['visibility'],
): NormalizationDependencies {
  countWork('projection.normalizationIndexesConstructed');
  const inputs = new PersistentMap<readonly string[]>(),
    outputs = new PersistentMap<readonly string[]>(),
    boundaries = new PersistentMap<readonly Boundary[]>(),
    raw = ownership.children(root.origin.representative),
    ids = raw.map(resourceKey),
    positions = new Map(ids.map((id, i) => [id, i]));
  for (const node of raw)
    boundaries.set(
      resourceKey(node),
      summarizeBoundary(node, ownership, interpretations, visibility),
    );
  for (const child of root.children) {
    const dependencies = normalizationInputs(child, ownership, key(root), ids, positions);
    inputs.set(key(child), dependencies);
    for (const input of dependencies)
      outputs.set(input, [...(outputs.get(input) ?? []), key(child)]);
  }
  return { inputs, outputs, boundaries };
}
/** Compare complete plain projection data, preserving every equal nested address
 * and origin object. Only records inside the actual normalization region enter. */
function freezeNew<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeNew(child);
    Object.freeze(value);
  }
  return value;
}
function retain<T>(before: T, after: T): T {
  countWork('projection.regionDataValuesCompared');
  if (Object.is(before, after)) return before;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object')
    return freezeNew(after);
  if (Array.isArray(before) !== Array.isArray(after)) return freezeNew(after);
  const old = before as Record<string, unknown>,
    value = after as Record<string, unknown>,
    keys = Object.keys(value);
  let same = Object.keys(old).length === keys.length;
  const result: Record<string, unknown> = Array.isArray(after)
    ? ([] as unknown as Record<string, unknown>)
    : {};
  for (const name of keys) {
    result[name] = retain(old[name], value[name]);
    if (!Object.hasOwn(old, name) || result[name] !== old[name]) same = false;
  }
  return same ? before : (Object.freeze(result) as T);
}
interface RegionInput {
  readonly before: {
    readonly root: ViewNode;
    readonly ownership: OwnershipResult;
    readonly dependencies: NormalizationDependencies;
    hasNode(id: string): boolean;
    node(id: string): ViewNode | undefined;
  };
  readonly ownership: OwnershipResult;
  readonly interpretations: Interpretations;
  readonly visibility: { get(id: string): NodeVisibility | undefined };
  readonly affected: readonly NodeId[];
  readonly rootRuns: ReadonlyMap<string, RunId>;
  readonly flowRoots: { get(id: string): RunId | undefined };
  projectInline(seed: ViewNode, run: RunId): ViewNode;
}
/** Reconstruct raw inputs only in connected normalization regions, then run the
 * existing complete one-pass normalizer once. Wrapper groups expand across their
 * raw neighbors; heading changes include the connected root section suffix.
 * A preceding non-section sibling is supplied as read-only ordering context.
 */
export function projectNormalizationRegion(input: RegionInput) {
  const affected = new Set(input.affected.map(resourceKey));
  const { before, ownership, interpretations } = input,
    root = before.root,
    rootId = root.origin.representative,
    rootKey = key(root),
    raw = ownership.children(rootId),
    ids = raw.map(resourceKey),
    positions = new Map(ids.map((id, i) => [id, i])),
    oldRaw = before.ownership.children(rootId),
    oldIds = oldRaw.map(resourceKey),
    oldPositions = new Map(oldIds.map((id, i) => [id, i])),
    region = new Set<string>(),
    gaps = new Set<number>();
  countWork('projection.regionRootEntriesInspected', raw.length + oldRaw.length);
  const addTop = (node: NodeId, source: OwnershipResult) => {
    const id = top(node, source, rootKey);
    // Former inputs still retract normalized outputs after moving beneath a
    // newly born wrapper. They need no current root position to be invalidated.
    if (id) region.add(id);
    // A moved-away input may expose a new merge at its former sibling gap.
    const oldIndex = id ? oldPositions.get(id) : undefined;
    if (id && oldIndex !== undefined && positions.get(id) !== oldIndex) gaps.add(oldIndex);
  };
  for (const node of input.affected) {
    addTop(node, ownership);
    if (before.hasNode(resourceKey(node))) addTop(node, before.ownership);
  }
  const type = (id: NodeId) =>
    projectedNodeType(ownership.nodeAllocation(id), interpretations.properties(id));
  const boundaries = before.dependencies.boundaries.fork();
  for (const id of oldIds) if (!positions.has(id)) boundaries.delete(id);
  const summaries = raw.map((node, i) => {
    const id = ids[i];
    countWork('projection.normalizationBoundarySummariesRead');
    if (region.has(id) || !boundaries.has(id))
      boundaries.set(id, summarizeBoundary(node, ownership, interpretations, input.visibility));
    return boundaries.get(id)!;
  });
  // The shared normalizer merges equal wrapper runs BEFORE cleanup. Retain that
  // boundary schedule, then connect empty groups only to the preceding survivor
  // whose origins their cleanup can change. Different nonempty wrappers stop
  // expansion. This schedules raw inputs; the shared pass still computes output.
  const groups: { type: ViewNode['type']; from: number; to: number; survives: boolean }[] = [];
  for (const [i, entries] of summaries.entries())
    for (const entry of entries) {
      countWork('projection.normalizationBoundaryEntriesInspected');
      const previous = groups.at(-1);
      if (previous && wrapper(entry.type) && previous.type === entry.type) {
        previous.to = i;
        previous.survives ||= entry.survives;
      } else groups.push({ type: entry.type, from: i, to: i, survives: entry.survives });
    }
  const spans: { from: number; to: number }[] = [];
  const connect = (from: number, to: number) => {
    if (from !== to) spans.push({ from, to });
  };
  let survivor: (typeof groups)[number] | undefined;
  for (const group of groups) {
    connect(group.from, group.to);
    if (group.survives) survivor = group;
    else if (survivor && wrapper(group.type) && survivor.type === group.type)
      connect(survivor.from, group.to);
  }
  // An arriving/restored barrier may split a previously merged output without
  // having belonged to that output before. Locate its current gap between the
  // old contributors, so their output is retracted as well as the new barrier.
  for (const output of root.children) {
    const members = (before.dependencies.inputs.get(key(output)) ?? []).flatMap((id) => {
      countWork('projection.normalizationPriorBoundaryInputsInspected');
      return positions.has(id) ? [positions.get(id)!] : [];
    });
    if (members.length) connect(Math.min(...members), Math.max(...members));
  }
  spans.sort((a, b) => {
    countWork('projection.normalizationBoundaryOrderComparisons');
    return a.from - b.from || a.to - b.to;
  });
  const ranges: { from: number; to: number }[] = [];
  for (const span of spans) {
    const previous = ranges.at(-1);
    if (previous && previous.to >= span.from) {
      previous.to = Math.max(previous.to, span.to);
      countWork('projection.normalizationBoundaryRangesMerged');
    } else ranges.push({ ...span });
  }
  const rangeAt: ({ from: number; to: number } | undefined)[] = [];
  for (const range of ranges)
    for (let i = range.from; i <= range.to; i++) {
      rangeAt[i] = range;
      countWork('projection.normalizationBoundaryRangeEntriesIndexed');
    }
  if (gaps.size) {
    // A batch can move several adjacent barriers while retaining their root
    // allocations. Find the former outside neighbors once, skipping the whole
    // changed band rather than testing each moved node against another mover.
    const left: (number | undefined)[] = [],
      right: (number | undefined)[] = [];
    let previous: number | undefined, next: number | undefined;
    for (let i = 0; i < oldIds.length; i++) {
      left[i] = previous;
      if (positions.has(oldIds[i]) && !region.has(oldIds[i])) previous = i;
      countWork('projection.normalizationFormerGapEntriesInspected');
    }
    for (let i = oldIds.length - 1; i >= 0; i--) {
      right[i] = next;
      if (positions.has(oldIds[i]) && !region.has(oldIds[i])) next = i;
      countWork('projection.normalizationFormerGapEntriesInspected');
    }
    for (const gap of gaps) {
      const a = left[gap] === undefined ? undefined : positions.get(oldIds[left[gap]!]),
        b = right[gap] === undefined ? undefined : positions.get(oldIds[right[gap]!]);
      if (a !== undefined && b !== undefined && rangeAt[a] && rangeAt[a] === rangeAt[b])
        region.add(ids[a]);
    }
  }
  const visitedOutputs = new Set<string>(),
    visitedRanges = new Set<object>(),
    firstSection = summaries.findIndex((nodes) => nodes.some((n) => n.type === 'section'));
  let sectionsExpanded = false;
  // Set iteration consumes newly added inputs. Each output/range is expanded
  // once, including negative gap dependencies; a wide merge is not quadratic.
  for (const id of region) {
    for (const output of before.dependencies.outputs.get(id) ?? []) {
      countWork('projection.normalizationOutputEdgesInspected');
      if (visitedOutputs.has(output)) continue;
      visitedOutputs.add(output);
      const members = (before.dependencies.inputs.get(output) ?? []).flatMap((dependency) => {
        countWork('projection.normalizationInputEdgesInspected');
        return positions.has(dependency) ? [positions.get(dependency)!] : [];
      });
      if (members.length)
        for (let i = Math.min(...members); i <= Math.max(...members); i++) {
          region.add(ids[i]);
          countWork('projection.normalizationRegionEntriesExpanded');
        }
    }
    const i = positions.get(id),
      range = i === undefined ? undefined : rangeAt[i];
    if (range && !visitedRanges.has(range)) {
      visitedRanges.add(range);
      for (let j = range.from; j <= range.to; j++) {
        region.add(ids[j]);
        countWork('projection.normalizationRegionEntriesExpanded');
      }
    }
    // Section normalization owns the suffix from the first root section.
    if (!sectionsExpanded && firstSection >= 0 && i !== undefined && i >= firstSection) {
      sectionsExpanded = true;
      for (let j = firstSection; j < raw.length; j++) {
        region.add(ids[j]);
        countWork('projection.normalizationRegionEntriesExpanded');
      }
    }
  }
  const oldOutputs = new Set<string>();
  for (const id of region)
    for (const output of before.dependencies.outputs.get(id) ?? []) oldOutputs.add(output);
  const removed = root.children.filter((node) => oldOutputs.has(key(node)));
  const build = (id: NodeId): ViewNode[] => {
    const idKey = resourceKey(id);
    if (!input.visibility.get(idKey)?.available) return [];
    const allocation = ownership.nodeAllocation(id),
      placement = ownership.blockPlacement(id),
      seed = rawProjectionNode(
        allocation,
        interpretations.properties(id),
        placement ? { type: 'edge', child: id, slot: placement.slot } : null,
      ),
      children = ownership.children(id).flatMap(build);
    countWork('projection.regionRawNodesBuilt');
    touchWork('projection.regionRawNodes', idKey);
    const absorbed = allocation.flow && resourceKey(ownership.flowBlock(allocation.flow)) !== idKey;
    if (absorbed) return children;
    let node: ViewNode = seed;
    if (allocation.flow) {
      const run = input.rootRuns.get(idKey) ?? input.flowRoots.get(resourceKey(allocation.flow));
      if (!run) throw new Error('Normalization input lacks a retained root run');
      const prior = before.node(idKey);
      if (!affected.has(idKey) && prior && prior.origin.constituents.length === 1) {
        node = {
          ...seed,
          content: prior.content,
          fragments: prior.fragments,
          boundaries: prior.boundaries,
        };
        countWork('projection.regionFlowRecordsReused');
      } else node = input.projectInline(seed, run);
    }
    if (node.type === 'paragraph' || node.type === 'code-block') return [node, ...children];
    if (children.some((child) => !isAllowedSemanticChild(node.type, child.type)))
      throw new Error('Illegal regional projected child');
    if (['list', 'list-item', 'block-quote'].includes(node.type) && placement) {
      const last = ownership.children(id).at(-1);
      node = {
        ...node,
        wrappers: [
          {
            node: id,
            edge: { type: 'edge', child: id, slot: placement.slot },
            start: { parent: id, predecessor: null },
            end: {
              parent: id,
              predecessor: last ? ownership.blockPlacement(last)!.occurrence : null,
            },
          },
        ],
      };
    }
    return [{ ...node, children }];
  };
  // Disconnected sibling regions have independent normalization boundaries.
  const regions: string[][] = [];
  for (const id of ids)
    if (region.has(id)) {
      const last = regions.at(-1);
      if (last && positions.get(last.at(-1)!)! + 1 === positions.get(id)) last.push(id);
      else regions.push([id]);
    }
  const output: ViewNode[] = [];
  for (const group of regions) {
    const children = group.flatMap((id) => build(raw[positions.get(id)!]));
    // A real preceding non-section sibling controls the first-section rule.
    // Its subtree is outside this connected range and is never normalized here.
    const first = positions.get(group[0])!;
    let preceding = first - 1;
    while (preceding >= 0 && !summaries[preceding].length) preceding--;
    const predecessor = summaries[preceding]?.at(-1)?.node;
    let context: ViewNode | undefined;
    if (children.some((node) => node.type === 'section') && predecessor) {
      if (type(predecessor) === 'section') throw new Error('Incomplete connected section range');
      const placement = ownership.blockPlacement(predecessor)!;
      context = rawProjectionNode(
        ownership.nodeAllocation(predecessor),
        interpretations.properties(predecessor),
        { type: 'edge', child: predecessor, slot: placement.slot },
      );
    }
    const normalized = normalizeProjection({
      ...root,
      children: [...(context ? [context] : []), ...children],
    });
    output.push(...normalized.children.filter((node) => !context || key(node) !== key(context)));
    countWork('projection.normalizationRegions');
  }
  const reconcile = (node: ViewNode): ViewNode => {
    const prior = before.node(key(node)),
      children = Object.freeze(node.children.map(reconcile));
    if (!prior) return retain(undefined as unknown as ViewNode, { ...node, children });
    const fields = {
      ...node,
      children:
        prior.children.length === children.length &&
        prior.children.every((child, i) => child === children[i])
          ? prior.children
          : children,
    };
    // Children were already compared above; avoid traversing their subtrees again.
    const metadata = retain({ ...prior, children: null }, { ...fields, children: null });
    return metadata.children === null &&
      Object.keys(metadata).every(
        (name) =>
          name === 'children' ||
          (metadata as unknown as Record<string, unknown>)[name] ===
            (prior as unknown as Record<string, unknown>)[name],
      ) &&
      fields.children === prior.children
      ? prior
      : Object.freeze({ ...metadata, children: fields.children });
  };
  const outputs = output.map(reconcile),
    dependencies = {
      inputs: before.dependencies.inputs.fork(),
      outputs: before.dependencies.outputs.fork(),
      boundaries,
    };
  for (const node of removed) {
    const id = key(node);
    for (const raw of dependencies.inputs.get(id) ?? [])
      dependencies.outputs.set(
        raw,
        (dependencies.outputs.get(raw) ?? []).filter((output) => output !== id),
      );
    dependencies.inputs.delete(id);
  }
  for (const node of outputs) {
    const inputs = normalizationInputs(node, ownership, rootKey, ids, positions);
    dependencies.inputs.set(key(node), inputs);
    for (const raw of inputs)
      dependencies.outputs.set(raw, [...(dependencies.outputs.get(raw) ?? []), key(node)]);
  }
  const byId = new Map(
      [...root.children.filter((node) => !oldOutputs.has(key(node))), ...outputs].map((node) => [
        key(node),
        node,
      ]),
    ),
    children: ViewNode[] = [],
    seen = new Set<string>();
  for (const id of ids)
    for (const output of dependencies.outputs.get(id) ?? [])
      if (!seen.has(output)) {
        const node = byId.get(output);
        if (!node) throw new Error('Missing normalized region output');
        children.push(node);
        seen.add(output);
      }
  return {
    root: Object.freeze({ ...root, children: Object.freeze(children) }),
    outputs,
    removed,
    dependencies,
  };
}
