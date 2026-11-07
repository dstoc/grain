import type { NodeId, TapeId, FlowId } from '../contracts.js';
import type { OwnershipResult } from '../ownership/ownership.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import type { NodeVisibility, TextVisibility, VisibilityNode } from '../visibility/visibility.js';
import { resourceKey } from '../layout/index.js';
import { countWork, touchWork } from '../diagnostics.js';
import { PersistentMap } from './map.js';

interface Record {
  readonly allocation: VisibilityNode;
  readonly parent: string | null;
  readonly birth: boolean;
  readonly required: boolean;
  readonly content: number;
  /** Number of nondeleted own witnesses in the current raw subtree. */
  readonly total: number;
  readonly own: boolean;
}
interface Inputs {
  readonly ownership: OwnershipResult;
  readonly runFlows: { get(id: string): FlowId | undefined };
  readonly activity: Activity;
  birthEnabled(node: NodeId): boolean;
  requirements(node: NodeId): readonly EffectRef[];
}
interface Changes extends Omit<Inputs, 'runFlows'> {
  /** Changed allocations, raw placements, birth activity, tags or requirements. */
  readonly nodes: readonly NodeId[];
  tags(node: NodeId): readonly NodeVisibility['tags'][number][];
}
const birthActive = (node: VisibilityNode, input: Omit<Inputs, 'runFlows'>) =>
  (node.id.birth.type === 'genesis' || input.activity.isActive(node.id.birth.action)) &&
  input.birthEnabled(node.id);
const sameTags = (a: NodeVisibility['tags'], b: NodeVisibility['tags']) =>
  a.length === b.length && a.every((tag, i) => resourceKey(tag) === resourceKey(b[i]));

/** Availability is a retained subtree witness count, independent of ownership
 * and normalized membership. Only changed raw paths and their child summaries
 * are inspected. A publication owns these roots, never a native reader/callback.
 */
export class VisibilityWitnesses {
  private constructor(
    private readonly records = new PersistentMap<Record>(),
    private readonly children = new PersistentMap<readonly string[]>(),
    private readonly tapeWitnesses = new PersistentMap<ReadonlyMap<string, number>>(),
    readonly nodes = new PersistentMap<NodeVisibility>(),
  ) {}
  static create(
    allocations: Iterable<VisibilityNode>,
    visibility: {
      readonly nodes: readonly NodeVisibility[];
      readonly text: readonly TextVisibility[];
    },
    input: Inputs,
  ): VisibilityWitnesses {
    countWork('witness.fullIndexesConstructed');
    const result = new VisibilityWitnesses();
    for (const entry of visibility.nodes) result.nodes.set(resourceKey(entry.node), entry);
    for (const allocation of allocations) {
      const id = resourceKey(allocation.id),
        parent = input.ownership.blockPlacement(allocation.id)?.slot.parent;
      result.records.set(id, {
        allocation,
        parent: parent ? resourceKey(parent) : null,
        birth: birthActive(allocation, input),
        required: input.requirements(allocation.id).some((ref) => {
          countWork('witness.requirementActivityChecks');
          return input.activity.isEffectActive(ref);
        }),
        content: 0,
        total: 0,
        own: false,
      });
      result.children.set(id, input.ownership.children(allocation.id).map(resourceKey));
    }
    const tapes = new Map<string, TextVisibility[]>();
    for (const entry of visibility.text) {
      const id = resourceKey(entry.token.tape),
        list = tapes.get(id) ?? [];
      list.push(entry);
      tapes.set(id, list);
    }
    const dirty = new Set(result.records.keys());
    for (const [id, entries] of tapes)
      result.replaceText(id, entries, input.ownership, dirty, input.runFlows);
    result.finish(dirty);
    // Keep the full reducer's records (including weak derivation suppression).
    // A separate caller certificate is needed before updating such a derivation.
    for (const entry of visibility.nodes) result.nodes.set(resourceKey(entry.node), entry);
    return result;
  }
  prepare(input: Changes) {
    const draft = new VisibilityWitnesses(
        this.records.fork(),
        this.children.fork(),
        this.tapeWitnesses.fork(),
        this.nodes.fork(),
      ),
      dirty = new Set<string>(),
      changedDeletion = new Set<string>();
    const markPath = (start: string | null, records: PersistentMap<Record>) => {
      const seen = new Set<string>();
      for (let id = start; id; id = records.get(id)?.parent ?? null) {
        if (seen.has(id)) throw new Error('Raw visibility placement contains a cycle');
        seen.add(id);
        dirty.add(id);
        countWork('witness.ancestorEdgesVisited');
      }
    };
    // Install all final parents first. A valid multi-node move need not have a
    // valid intermediate parent order.
    for (const node of input.nodes) {
      const id = resourceKey(node),
        old = this.records.get(id),
        allocation = input.ownership.nodeAllocation(node),
        parent = input.ownership.blockPlacement(node)?.slot.parent;
      draft.records.set(id, {
        allocation,
        parent: parent ? resourceKey(parent) : null,
        birth: birthActive(allocation, input),
        required: input.requirements(node).some((ref) => {
          countWork('witness.requirementActivityChecks');
          return input.activity.isEffectActive(ref);
        }),
        content: old?.content ?? 0,
        total: old?.total ?? 0,
        own: old?.own ?? false,
      });
      const tags = input.tags(node),
        prior = draft.nodes.get(id);
      draft.nodes.set(
        id,
        prior && sameTags(prior.tags, tags)
          ? prior
          : {
              node,
              tags,
              deleted: prior?.deleted ?? false,
              suppressed: prior?.suppressed ?? false,
              scaffold: prior?.scaffold ?? false,
              available: prior?.available ?? false,
            },
      );
      dirty.add(id);
      changedDeletion.add(id);
      if (old?.parent) {
        draft.children.set(
          old.parent,
          input.ownership.children(this.records.get(old.parent)!.allocation.id).map(resourceKey),
        );
        markPath(old.parent, this.records);
      }
      if (parent)
        draft.children.set(resourceKey(parent), input.ownership.children(parent).map(resourceKey));
      draft.children.set(id, input.ownership.children(node).map(resourceKey));
      countWork('witness.resourcesUpdated');
    }
    const visiting = new Set<string>(),
      refreshed = new Set<string>();
    const refreshDeleted = (id: string): void => {
      if (refreshed.has(id)) return;
      if (visiting.has(id)) throw new Error('Raw visibility placement contains a cycle');
      visiting.add(id);
      const record = draft.records.get(id);
      if (!record) throw new Error('Unknown visibility ancestor');
      countWork('witness.deletionAncestorsChecked');
      if (record.parent) refreshDeleted(record.parent);
      const previous = draft.nodes.get(id)!,
        deleted =
          !!previous.tags.length || !!(record.parent && draft.nodes.get(record.parent)?.deleted);
      visiting.delete(id);
      refreshed.add(id);
      if (previous.deleted !== deleted) {
        draft.nodes.set(id, { ...previous, deleted });
        dirty.add(id);
        for (const child of draft.children.get(id) ?? []) {
          changedDeletion.add(child);
        }
      }
    };
    // The Set iterator also visits newly scheduled descendants. Only parent
    // edges recurse: a child can already be waiting for this parent to finish.
    // Recursing back down then would mistake that valid wait for a raw cycle.
    for (const id of changedDeletion) refreshDeleted(id);
    const paths = [...dirty];
    for (const id of paths) markPath(id, draft.records);
    return { draft, dirty };
  }
  deleted(node: NodeId): boolean {
    const entry = this.nodes.get(resourceKey(node));
    if (!entry) throw new Error('Unknown text destination visibility');
    return entry.deleted;
  }
  replaceText(
    tape: string,
    entries: readonly TextVisibility[],
    ownership: OwnershipResult,
    dirty: Set<string>,
    runFlows: Inputs['runFlows'],
    previous?: ReadonlyMap<string, TextVisibility>,
  ): void {
    const counts = previous ? new Map(this.tapeWitnesses.get(tape)) : new Map<string, number>(),
      owners = new Map<string, string>();
    for (const entry of entries) {
      countWork('witness.textEntriesInspected');
      const old = previous?.get(`${entry.token.native.client}:${entry.token.native.clock}`);
      const difference = Number(entry.visible) - Number(old?.visible ?? false);
      if (!difference) continue;
      const run = resourceKey(ownership.owner(entry.token).run);
      let id = owners.get(run);
      if (!id) {
        const flow = runFlows.get(run);
        if (!flow) throw new Error('Witness owner lacks a retained run flow');
        id = resourceKey(ownership.flowBlock(flow));
        owners.set(run, id);
      }
      const count = (counts.get(id) ?? 0) + difference;
      if (count < 0) throw new Error('Negative retained text witness count');
      if (count) counts.set(id, count);
      else counts.delete(id);
    }
    const before = this.tapeWitnesses.get(tape);
    for (const id of new Set([...(before?.keys() ?? []), ...counts.keys()])) {
      const difference = (counts.get(id) ?? 0) - (before?.get(id) ?? 0);
      if (!difference) continue;
      const record = this.records.get(id);
      if (!record) throw new Error('Unknown text witness owner');
      this.records.set(id, { ...record, content: record.content + difference });
      dirty.add(id);
    }
    this.tapeWitnesses.set(tape, counts);
  }
  finish(dirty: Set<string>) {
    // Text witness changes may add new ancestor paths after prepare().
    const paths = [...dirty];
    for (const start of paths) {
      const seen = new Set<string>();
      for (let id: string | null = start; id; id = this.records.get(id)!.parent) {
        if (seen.has(id)) throw new Error('Raw visibility placement contains a cycle');
        seen.add(id);
        dirty.add(id);
      }
    }
    const done = new Set<string>(),
      visiting = new Set<string>(),
      changed = new Set<string>();
    const visit = (id: string): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new Error('Raw visibility placement contains a cycle');
      visiting.add(id);
      const record = this.records.get(id)!,
        previous = this.nodes.get(id)!;
      const own = !previous.deleted && (record.birth || record.required || record.content > 0);
      let total = Number(own);
      for (const child of this.children.get(id) ?? []) {
        countWork('witness.childSummariesRead');
        if (dirty.has(child)) visit(child);
        total += this.records.get(child)!.total;
      }
      this.records.set(id, { ...record, own, total });
      const kept = total > 0,
        suppressed = !record.birth && !kept,
        scaffold = !record.birth && kept,
        available = kept && !previous.deleted;
      if (
        previous.suppressed !== suppressed ||
        previous.scaffold !== scaffold ||
        previous.available !== available
      ) {
        this.nodes.set(id, { ...previous, suppressed, scaffold, available });
        changed.add(id);
      }
      visiting.delete(id);
      done.add(id);
      countWork('witness.recordsRebuilt');
      touchWork('witness.records', id);
    };
    for (const id of dirty) visit(id);
    return changed;
  }
  replaceTapes(
    tapes: readonly TapeId[],
    text: { get(id: string): { readonly entries: readonly TextVisibility[] } | undefined },
    ownership: OwnershipResult,
    dirty: Set<string>,
    runFlows: Inputs['runFlows'],
    previous?: {
      get(id: string): { readonly byId: ReadonlyMap<string, TextVisibility> } | undefined;
    },
  ) {
    for (const tape of tapes)
      this.replaceText(
        resourceKey(tape),
        text.get(resourceKey(tape))?.entries ?? [],
        ownership,
        dirty,
        runFlows,
        previous?.get(resourceKey(tape))?.byId,
      );
  }
}
