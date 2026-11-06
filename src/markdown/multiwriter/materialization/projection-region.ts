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
export interface NormalizationDependencies {
  readonly inputs: PersistentMap<readonly string[]>;
  readonly outputs: PersistentMap<readonly string[]>;
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
export function normalizationInputs(
  node: ViewNode,
  ownership: OwnershipResult,
  root: string,
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
  return [...inputs];
}
export function indexNormalization(
  root: ViewNode,
  ownership: OwnershipResult,
): NormalizationDependencies {
  countWork('projection.normalizationIndexesConstructed');
  const inputs = new PersistentMap<readonly string[]>(),
    outputs = new PersistentMap<readonly string[]>();
  for (const child of root.children) {
    const dependencies = normalizationInputs(child, ownership, key(root));
    inputs.set(key(child), dependencies);
    for (const input of dependencies)
      outputs.set(input, [...(outputs.get(input) ?? []), key(child)]);
  }
  return { inputs, outputs };
}
/** Compare complete plain projection data, preserving every equal nested address
 * and origin object. Only records inside the actual normalization region enter. */
function retain<T>(before: T, after: T): T {
  countWork('projection.regionDataValuesCompared');
  if (Object.is(before, after)) return before;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return after;
  if (Array.isArray(before) !== Array.isArray(after)) return after;
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
    region = new Set<string>();
  countWork('projection.regionRootEntriesInspected', raw.length + oldRaw.length);
  const addTop = (node: NodeId, source: OwnershipResult) => {
    const id = top(node, source, rootKey);
    // Former inputs still retract normalized outputs after moving beneath a
    // newly born wrapper. They need no current root position to be invalidated.
    if (id) region.add(id);
    if (id) {
      // A moved-away top-level input still invalidates its former sibling gap.
      const oldIndex = oldPositions.get(id);
      if (!positions.has(id) && oldIndex !== undefined)
        for (const neighbor of [oldIds[oldIndex - 1], oldIds[oldIndex + 1]])
          if (positions.has(neighbor)) region.add(neighbor);
    }
  };
  for (const node of input.affected) {
    addTop(node, ownership);
    if (before.hasNode(resourceKey(node))) addTop(node, before.ownership);
  }
  const type = (id: NodeId) =>
    projectedNodeType(ownership.nodeAllocation(id), interpretations.properties(id));
  const summary = (id: NodeId): { node: NodeId; type: ViewNode['type'] }[] => {
    countWork('projection.normalizationBoundarySummariesRead');
    if (!input.visibility.get(resourceKey(id))?.available) return [];
    const allocation = ownership.nodeAllocation(id),
      kind = type(id);
    if (allocation.flow && resourceKey(ownership.flowBlock(allocation.flow)) !== resourceKey(id))
      return ownership.children(id).flatMap(summary);
    return [
      { node: id, type: kind },
      ...(['paragraph', 'code-block'].includes(kind)
        ? ownership.children(id).flatMap(summary)
        : []),
    ];
  };
  const summaries = raw.map(summary);
  const wrapper = (id: string) => {
    const i = positions.get(id);
    return i !== undefined && summaries[i].some((s) => ['list', 'block-quote'].includes(s.type));
  };
  let expanded = true;
  while (expanded) {
    const size = region.size;
    for (const id of region) {
      for (const output of before.dependencies.outputs.get(id) ?? []) {
        const members = (before.dependencies.inputs.get(output) ?? []).flatMap((dependency) =>
          positions.has(dependency) ? [positions.get(dependency)!] : [],
        );
        // Invisible raw siblings do not separate a merged projection group.
        // Keep their gaps in the shared pass; available empty wrappers still
        // remain real barriers until that pass's cleanup stage.
        if (members.length)
          for (let i = Math.min(...members); i <= Math.max(...members); i++) region.add(ids[i]);
      }
      const i = positions.get(id)!;
      for (const neighbor of [ids[i - 1], ids[i + 1]])
        if (neighbor && wrapper(neighbor)) region.add(neighbor);
    }
    // Full section normalization joins root section ranges after moving trailing
    // blocks. Its true dependency is the suffix from the first root section.
    const first = summaries.findIndex((nodes) => nodes.some((n) => n.type === 'section'));
    if (first >= 0 && [...region].some((id) => positions.get(id)! >= first))
      for (let i = first; i < raw.length; i++) region.add(ids[i]);
    expanded = size !== region.size;
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
  const groups: string[][] = [];
  for (const id of ids)
    if (region.has(id)) {
      const last = groups.at(-1);
      if (last && positions.get(last.at(-1)!)! + 1 === positions.get(id)) last.push(id);
      else groups.push([id]);
    }
  const output: ViewNode[] = [];
  for (const group of groups) {
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
      children = node.children.map(reconcile);
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
    const inputs = normalizationInputs(node, ownership, rootKey);
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
