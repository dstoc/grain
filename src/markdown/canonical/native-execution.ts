import * as Y from 'yjs';

import { diffChildSplices } from './plan/child-splices.js';
import type { LowLevelPlan } from './plan/draft.js';
import {
  immutableCell,
  metaMap,
  nodeMap,
  revisionMap,
  sessionWatermarkMap,
  tapeMap,
} from './state-access.js';
import type { RecordMap } from './state-access.js';
import type { BoundaryEmbed, TapeId } from './types.js';
import type { NodeId } from '../semantic/types.js';
import type { CellField, StructuralPatch } from './action-types.js';
import { mapTextEdit } from '../canonical-text.js';
import type { NativeTextRun } from '../canonical-text.js';
import { stableJson } from './util.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function boundarySignature(tape: Y.Text): string {
  return stableJson(
    tape
      .toDelta()
      .flatMap((part: { readonly insert: unknown }) =>
        typeof part.insert === 'string' ? [] : [part.insert],
      ),
  );
}

export interface NativeMutationEvidence {
  readonly changedTapeIds: Set<TapeId>;
  readonly changedOtherTypes: Set<unknown>;
  readonly changedNodeCells: Map<NodeId, Set<CellField>>;
  readonly changedNodeIds: Set<NodeId>;
  readonly changedTapeRegistryIds: Set<TapeId>;
  readonly changedRevisionIds: Set<TapeId>;
  readonly changedMetaKeys: Set<string>;
  readonly changedWatermarkKeys: Set<string>;
  registerNode(id: NodeId, record: RecordMap): void;
  registerTape(id: TapeId, tape: Y.Text): void;
  close(): void;
}

/** Collect native Yjs mutation evidence without scanning tapes after each action. */
export function trackNativeMutations(
  state: Y.Doc,
  knownResources?: {
    readonly tapeIds?: ReadonlySet<TapeId>;
    readonly nodeIds?: ReadonlySet<NodeId>;
  },
): NativeMutationEvidence {
  const nodes = nodeMap(state);
  const tapes = tapeMap(state);
  const revisions = revisionMap(state);
  const meta = metaMap(state);
  const watermarks = sessionWatermarkMap(state);
  const nodeIds = new WeakMap<Y.Map<unknown>, NodeId>();
  const childArrayIds = new WeakMap<Y.Array<NodeId>, NodeId>();
  const tapeIds = new WeakMap<Y.Text, TapeId>();
  const changedTapeIds = new Set<TapeId>();
  const changedOtherTypes = new Set<unknown>();
  const changedNodeCells = new Map<NodeId, Set<CellField>>();
  const changedNodeIds = new Set<NodeId>();
  const changedTapeRegistryIds = new Set<TapeId>();
  const changedRevisionIds = new Set<TapeId>();
  const changedMetaKeys = new Set<string>();
  const changedWatermarkKeys = new Set<string>();
  if (!knownResources) {
    for (const [id, record] of nodes.entries()) {
      nodeIds.set(record, id);
      const children = record.get('children');
      if (children instanceof Y.Array) childArrayIds.set(children, id);
    }
    for (const [id, tape] of tapes.entries()) tapeIds.set(tape, id);
  } else {
    for (const id of knownResources.nodeIds ?? []) {
      const record = nodes.get(id);
      if (record) {
        nodeIds.set(record, id);
        const children = record.get('children');
        if (children instanceof Y.Array) childArrayIds.set(children, id);
      }
    }
    for (const id of knownResources.tapeIds ?? []) {
      const tape = tapes.get(id);
      if (tape) tapeIds.set(tape, id);
    }
  }

  const onAfterTransaction = (transaction: Y.Transaction) => {
    for (const [type, keys] of transaction.changed) {
      const sharedType: unknown = type;
      let known = false;
      if (type instanceof Y.Text) {
        const id = tapeIds.get(type);
        if (id) {
          changedTapeIds.add(id);
          known = true;
        }
      }
      if (sharedType === nodes) {
        known = true;
        for (const key of keys) if (key !== null) changedNodeIds.add(key);
      }
      if (sharedType === tapes) {
        known = true;
        for (const key of keys) if (key !== null) changedTapeRegistryIds.add(key);
      }
      if (sharedType === revisions) {
        known = true;
        for (const key of keys) if (key !== null) changedRevisionIds.add(key);
      }
      if (sharedType === meta) {
        known = true;
        for (const key of keys) if (key !== null) changedMetaKeys.add(key);
      }
      if (sharedType === watermarks) {
        known = true;
        for (const key of keys) if (key !== null) changedWatermarkKeys.add(key);
      }
      const nodeId = nodeIds.get(sharedType as Y.Map<unknown>);
      if (nodeId) {
        known = true;
        const fields = changedNodeCells.get(nodeId) ?? new Set<CellField>();
        for (const key of keys) {
          if (
            key === 'kind' ||
            key === 'spans' ||
            key === 'marker' ||
            key === 'checked' ||
            key === 'info' ||
            key === 'childrenToken'
          ) {
            fields.add(key === 'childrenToken' ? 'children' : key);
          }
        }
        changedNodeCells.set(nodeId, fields);
      }
      if (type instanceof Y.Array) {
        const childNodeId = childArrayIds.get(type as Y.Array<NodeId>);
        if (childNodeId) {
          const fields = changedNodeCells.get(childNodeId) ?? new Set<CellField>();
          fields.add('children');
          changedNodeCells.set(childNodeId, fields);
          known = true;
        }
      }
      if (!known) changedOtherTypes.add(type);
    }
  };
  state.on('afterTransaction', onAfterTransaction);
  return {
    changedTapeIds,
    changedOtherTypes,
    changedNodeCells,
    changedNodeIds,
    changedTapeRegistryIds,
    changedRevisionIds,
    changedMetaKeys,
    changedWatermarkKeys,
    registerNode(id, record) {
      nodeIds.set(record, id);
      const children = record.get('children');
      if (children instanceof Y.Array) childArrayIds.set(children, id);
    },
    registerTape(id, tape) {
      tapeIds.set(tape, id);
    },
    close() {
      state.off('afterTransaction', onAfterTransaction);
    },
  };
}

function mergeRuns(runs: readonly NativeTextRun[]): NativeTextRun[] {
  const sorted = [...runs].sort((a, b) => a.tapeId.localeCompare(b.tapeId) || a.from - b.from);
  const merged: NativeTextRun[] = [];
  for (const run of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.tapeId === run.tapeId && run.from <= previous.to) {
      merged[merged.length - 1] = { ...previous, to: Math.max(previous.to, run.to) };
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function indexAfterDeletes(
  index: number,
  deletions: readonly NativeTextRun[],
  tapeId: TapeId,
): number {
  let removed = 0;
  for (const run of deletions
    .filter((item) => item.tapeId === tapeId)
    .sort((a, b) => a.from - b.from)) {
    if (index <= run.from) break;
    if (index < run.to) return run.from - removed;
    removed += run.to - run.from;
  }
  return index - removed;
}

export function applyPlan(
  state: Y.Doc,
  plan: LowLevelPlan,
  textOrigin: object,
  nextRevision: number,
  mutations: NativeMutationEvidence,
  afterAllocations?: () => void,
): void {
  if (plan.allocations.length || plan.newTapes.length) {
    state.transact(() => {
      for (const { id, span } of plan.newTapes) {
        const tape = new Y.Text();
        tape.insertEmbed(
          0,
          Object.freeze({ grainBoundary: span.startBoundaryId }) satisfies BoundaryEmbed,
        );
        tape.insertEmbed(
          1,
          Object.freeze({ grainBoundary: span.endBoundaryId }) satisfies BoundaryEmbed,
        );
        mutations.registerTape(id, tape);
        tapeMap(state).set(id, tape);
        revisionMap(state).set(id, 0);
      }
      for (const allocation of plan.allocations) {
        const record = new Y.Map<unknown>();
        record.set('children', new Y.Array<NodeId>());
        record.set('childrenToken', allocation.cells.children.token);
        for (const field of ['kind', 'spans', 'marker', 'checked', 'info'] as const) {
          record.set(field, allocation.cells[field]);
        }
        mutations.registerNode(allocation.id, record);
        nodeMap(state).set(allocation.id, record);
      }
    }, 'grain:allocate');
  }
  afterAllocations?.();

  const deletions = mergeRuns(plan.deletions);
  if (deletions.length) {
    state.transact(() => {
      for (const deletion of [...deletions].sort(
        (a, b) => a.tapeId.localeCompare(b.tapeId) || b.from - a.from,
      )) {
        const tape = tapeMap(state).get(deletion.tapeId);
        assert(tape, `missing text tape ${deletion.tapeId}`);
        tape.delete(deletion.from, deletion.to - deletion.from);
      }
    }, textOrigin);
  }

  if (plan.insertions.length) {
    state.transact(() => {
      const sorted = plan.insertions
        .map((insertion) => ({
          ...insertion,
          originalIndex: insertion.index,
          index: indexAfterDeletes(insertion.index, deletions, insertion.tapeId),
        }))
        // Same-index Y.Text inserts prepend, so apply later native gaps first.
        .sort(
          (a, b) =>
            a.tapeId.localeCompare(b.tapeId) ||
            b.index - a.index ||
            b.originalIndex - a.originalIndex ||
            b.slotOrder - a.slotOrder,
        );
      for (const insertion of sorted) {
        const tape = tapeMap(state).get(insertion.tapeId);
        assert(tape, `missing text tape ${insertion.tapeId}`);
        if (insertion.text) tape.insert(insertion.index, insertion.text);
      }
    }, textOrigin);
  }

  if (plan.boundaries.length) {
    state.transact(() => {
      const sorted = plan.boundaries
        .map((boundary) => {
          const index = indexAfterDeletes(boundary.index, deletions, boundary.tapeId);
          const priorInsertions = plan.insertions
            .filter((insertion) => insertion.tapeId === boundary.tapeId)
            .map((insertion) => ({ index: insertion.index, length: insertion.text.length }));
          // Deleted ranges can collapse distinct native gaps to the same index.
          // Compare their original positions to keep insertion-before-boundary order.
          const before = priorInsertions
            .filter((insertion) => insertion.index < boundary.index)
            .reduce((total, insertion) => total + insertion.length, 0);
          return {
            ...boundary,
            index: index + before + boundary.insertionOffset,
          };
        })
        .sort((a, b) => {
          const tapeOrder = a.tapeId.localeCompare(b.tapeId);
          if (tapeOrder) return tapeOrder;
          const indexOrder = b.index - a.index;
          if (indexOrder) return indexOrder;
          if (a.side !== b.side) return a.side === 'end' ? -1 : 1;
          return a.side === 'start' ? b.order - a.order : a.order - b.order;
        });
      for (const boundary of sorted) {
        const tape = tapeMap(state).get(boundary.tapeId);
        assert(tape, `missing boundary tape ${boundary.tapeId}`);
        tape.insertEmbed(
          boundary.index,
          Object.freeze({ grainBoundary: boundary.boundaryId }) satisfies BoundaryEmbed,
        );
      }
    }, 'grain:allocate-boundaries');
  }

  if (plan.writes.length) {
    state.transact(() => {
      for (const write of plan.writes) {
        const record = nodeMap(state).get(write.nodeId);
        assert(record, `missing node ${write.nodeId} for cell write`);
        if (write.field === 'children') {
          const children = record.get('children');
          assert(
            children instanceof Y.Array,
            `node ${write.nodeId} has no permanent children array`,
          );
          for (const splice of diffChildSplices(
            children.toArray(),
            write.value as readonly NodeId[],
          )) {
            if (splice.removedIds.length) children.delete(splice.index, splice.removedIds.length);
            if (splice.insertedIds.length) children.insert(splice.index, [...splice.insertedIds]);
          }
          record.set('childrenToken', write.token);
        } else {
          record.set(write.field, immutableCell(write.token, write.value));
        }
      }
    }, 'grain:structure');
  }

  state.transact(() => {
    const revisions = revisionMap(state);
    const changedTapeIds = new Set([
      ...mutations.changedTapeIds,
      ...plan.newTapes.map(({ id }) => id),
    ]);
    for (const id of changedTapeIds) revisions.set(id, nextRevision);
    metaMap(state).set('acceptedRevision', nextRevision);
  }, 'grain:revision');
}

export function applyStructuralPatch(
  state: Y.Doc,
  patch: StructuralPatch,
  direction: 'undo' | 'redo',
): void {
  const cells = [...patch.cells].reverse();
  state.transact(
    () => {
      const childLists = direction === 'undo' ? [...patch.childLists].reverse() : patch.childLists;
      for (const childList of childLists) {
        const record = nodeMap(state).get(childList.nodeId);
        assert(record, `missing structural node ${childList.nodeId}`);
        const children = record.get('children');
        assert(children instanceof Y.Array, `missing permanent children array ${childList.nodeId}`);
        const splices = direction === 'undo' ? [...childList.splices].reverse() : childList.splices;
        for (const splice of splices) {
          const removedIds = direction === 'undo' ? splice.insertedIds : splice.removedIds;
          const insertedIds = direction === 'undo' ? splice.removedIds : splice.insertedIds;
          if (removedIds.length) children.delete(splice.index, removedIds.length);
          if (insertedIds.length) children.insert(splice.index, [...insertedIds]);
        }
        record.set(
          'childrenToken',
          direction === 'undo' ? childList.beforeToken : childList.afterToken,
        );
      }
      for (const item of cells) {
        const record = nodeMap(state).get(item.nodeId);
        assert(record, `missing structural node ${item.nodeId}`);
        const value = direction === 'undo' ? item.before : item.after;
        record.set(item.field, immutableCell(value.token, value.value));
      }
    },
    direction === 'undo' ? 'grain:structural-undo' : 'grain:structural-redo',
  );
}

export function applyMappedTextEdit(
  state: Y.Doc,
  mapped: ReturnType<typeof mapTextEdit>,
  insert: string,
  origin: object,
): void {
  const deletions = mergeRuns(mapped.deletions);
  const tapes = tapeMap(state);
  if (deletions.length) {
    state.transact(() => {
      for (const run of [...deletions].sort(
        (a, b) => a.tapeId.localeCompare(b.tapeId) || b.from - a.from,
      )) {
        const tape = tapes.get(run.tapeId);
        assert(tape, `missing tape ${run.tapeId}`);
        tape.delete(run.from, run.to - run.from);
      }
    }, origin);
  }
  if (insert) {
    const index = indexAfterDeletes(mapped.insertion.index, deletions, mapped.insertion.tapeId);
    const tape = tapes.get(mapped.insertion.tapeId);
    assert(tape, `missing tape ${mapped.insertion.tapeId}`);
    state.transact(() => tape.insert(index, insert), origin);
  }
}

export function cloneDocument(state: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(state));
  return clone;
}

export function assertResolvedUpdate(state: Y.Doc): void {
  assert(!state.store.pendingStructs, 'text update has unresolved struct dependencies');
  assert(!state.store.pendingDs, 'text update has unresolved delete dependencies');
}
