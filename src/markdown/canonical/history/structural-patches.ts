import * as Y from 'yjs';

import { currentActive, nodeMap, readCell, tapeMap } from '../state-access.js';
import type { RecordMap } from '../state-access.js';
import { diffChildSplices } from '../plan/child-splices.js';
import type { LowLevelPlan } from '../plan/draft.js';
import { deepCopy, deepFreeze, stableJson } from '../util.js';
import type { BoundaryId, TapeId } from '../types.js';
import type { NodeId } from '../../semantic/types.js';
import type {
  CellField,
  StructuralCellPatch,
  StructuralCellValue,
  StructuralPatch,
  StructuralVisibility,
} from '../action-types.js';

const CELL_FIELDS: readonly CellField[] = [
  'kind',
  'children',
  'spans',
  'marker',
  'checked',
  'info',
];

interface NativeItem {
  readonly id: { readonly client: number; readonly clock: number };
  readonly right: NativeItem | null;
  readonly deleted: boolean;
  readonly content: unknown;
}

interface NativeSharedType {
  readonly _item: NativeItem | null;
  readonly _start: NativeItem | null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function nativeItemId(item: NativeItem): string {
  return `${item.id.client}:${item.id.clock}`;
}

function sharedTypeId(type: Y.Map<unknown> | Y.Text): string {
  const item = (type as unknown as NativeSharedType)._item;
  assert(item, 'canonical shared type is not integrated');
  return nativeItemId(item);
}

function markerItems(state: Y.Doc): Map<string, { tapeId: TapeId; itemId: string }> {
  const result = new Map<string, { tapeId: TapeId; itemId: string }>();
  for (const [tapeId, tape] of tapeMap(state)) {
    let item = (tape as unknown as NativeSharedType)._start;
    while (item) {
      const content = item.content;
      const embed =
        content && typeof content === 'object' && 'embed' in content
          ? (content as { embed: unknown }).embed
          : undefined;
      const boundaryId =
        embed && typeof embed === 'object' && 'grainBoundary' in embed
          ? (embed as { grainBoundary: unknown }).grainBoundary
          : undefined;
      if (!item.deleted && typeof boundaryId === 'string') {
        result.set(boundaryId, { tapeId, itemId: nativeItemId(item) });
      }
      item = item.right;
    }
  }
  return result;
}

function snapshotCell(record: RecordMap, field: CellField): StructuralCellValue {
  const cell = readCell<unknown>(record, field);
  return Object.freeze({ token: cell.token, value: deepFreeze(deepCopy(cell.value)) });
}

export function structuralPatchBetween(
  before: Y.Doc,
  after: Y.Doc,
  plan: LowLevelPlan,
): StructuralPatch {
  const beforeNodes = nodeMap(before);
  const afterNodes = nodeMap(after);
  const changedCells: StructuralCellPatch[] = [];
  const childLists: StructuralPatch['childLists'][number][] = [];
  const births: StructuralPatch['births'][number][] = [];
  const visibility: StructuralVisibility[] = [];
  const touched = new Set(plan.touchedNodes);
  const allocations = new Map(plan.allocations.map((item) => [item.id, item]));

  const recordChange = (
    nodeId: NodeId,
    field: CellField,
    oldCell: StructuralCellValue,
    newCell: StructuralCellValue,
  ) => {
    if (field === 'children') {
      if (oldCell.token === newCell.token && sameValue(oldCell.value, newCell.value)) return;
      childLists.push(
        Object.freeze({
          nodeId,
          beforeToken: oldCell.token,
          afterToken: newCell.token,
          splices: diffChildSplices(
            oldCell.value as readonly NodeId[],
            newCell.value as readonly NodeId[],
          ),
        }),
      );
      return;
    }
    if (oldCell.token !== newCell.token || !sameValue(oldCell.value, newCell.value)) {
      changedCells.push(Object.freeze({ nodeId, field, before: oldCell, after: newCell }));
    }
  };

  for (const nodeId of touched) {
    const oldRecord = beforeNodes.get(nodeId);
    const newRecord = afterNodes.get(nodeId);
    assert(newRecord, `structural plan omitted touched node ${nodeId}`);
    if (!oldRecord) {
      const allocation = allocations.get(nodeId);
      assert(allocation, `structural plan omitted allocation for ${nodeId}`);
      const cells = Object.fromEntries(
        CELL_FIELDS.map((field) => [field, allocation.cells[field]]),
      ) as Record<CellField, StructuralCellValue>;
      births.push(Object.freeze({ nodeId, cells: Object.freeze(cells) }));
      // Allocations begin with an empty child list. Edges added to a born
      // wrapper still need an inverse when they point at existing nodes;
      // otherwise undo leaves the same child listed by both detached and
      // active parents in the retained forest.
      for (const field of CELL_FIELDS) {
        const oldCell = allocation.cells[field];
        const newCell = snapshotCell(newRecord, field);
        recordChange(nodeId, field, oldCell, newCell);
      }
    } else {
      for (const field of CELL_FIELDS) {
        const oldCell = snapshotCell(oldRecord, field);
        const newCell = snapshotCell(newRecord, field);
        recordChange(nodeId, field, oldCell, newCell);
      }
    }
    visibility.push(
      Object.freeze({
        nodeId,
        before: oldRecord ? currentActive(before, nodeId) : false,
        after: currentActive(after, nodeId),
      }),
    );
  }

  const bornTapes = plan.newTapes.map(({ id }) => {
    const tape = tapeMap(after).get(id);
    assert(tape, `structural plan omitted born tape ${id}`);
    return Object.freeze({ tapeId: id, sharedTypeId: sharedTypeId(tape) });
  });
  const createdMarkers = new Set<BoundaryId>([
    ...plan.newTapes.flatMap(({ span }) => [span.startBoundaryId, span.endBoundaryId]),
    ...plan.boundaries.map((boundary) => boundary.boundaryId),
  ]);
  const allMarkers = markerItems(after);
  const bornMarkers = [...createdMarkers].map((boundaryId) => {
    const marker = allMarkers.get(boundaryId);
    assert(marker, `structural plan omitted born marker ${boundaryId}`);
    return Object.freeze({ ...marker, boundaryId });
  });
  const hasStructure = changedCells.length > 0 || childLists.length > 0 || births.length > 0;
  return Object.freeze({
    cells: Object.freeze(changedCells),
    childLists: Object.freeze(childLists),
    births: Object.freeze(births),
    visibility: Object.freeze(hasStructure ? visibility : []),
    bornTapes: Object.freeze(bornTapes),
    bornMarkers: Object.freeze(bornMarkers),
  });
}

export function structuralPatchWithLiveIdentities(
  patch: StructuralPatch,
  state: Y.Doc,
): StructuralPatch {
  const markers = patch.bornMarkers.length ? markerItems(state) : undefined;
  return Object.freeze({
    ...patch,
    bornTapes: Object.freeze(
      patch.bornTapes.map(({ tapeId }) => {
        const tape = tapeMap(state).get(tapeId);
        assert(tape, `missing born tape ${tapeId} after live apply`);
        return Object.freeze({ tapeId, sharedTypeId: sharedTypeId(tape) });
      }),
    ),
    bornMarkers: Object.freeze(
      patch.bornMarkers.map(({ boundaryId }) => {
        const marker = markers?.get(boundaryId);
        assert(marker, `missing born marker ${boundaryId} after live apply`);
        return Object.freeze({ ...marker, boundaryId });
      }),
    ),
  });
}

export function structuralPatchError(
  state: Y.Doc,
  patch: StructuralPatch,
  direction: 'undo' | 'redo',
): 'resource-conflict' | 'visibility-conflict' | undefined {
  const nodes = nodeMap(state);
  for (const cellPatch of patch.cells) {
    const record = nodes.get(cellPatch.nodeId);
    if (!record) return 'resource-conflict';
    const expected = direction === 'undo' ? cellPatch.after : cellPatch.before;
    const actual = snapshotCell(record, cellPatch.field);
    if (actual.token !== expected.token || !sameValue(actual.value, expected.value)) {
      return 'resource-conflict';
    }
  }
  const patchedBirthFields = new Map<NodeId, Set<CellField>>();
  for (const cellPatch of patch.cells) {
    const fields = patchedBirthFields.get(cellPatch.nodeId) ?? new Set<CellField>();
    fields.add(cellPatch.field);
    patchedBirthFields.set(cellPatch.nodeId, fields);
  }
  for (const childList of patch.childLists) {
    const fields = patchedBirthFields.get(childList.nodeId) ?? new Set<CellField>();
    fields.add('children');
    patchedBirthFields.set(childList.nodeId, fields);
    const record = nodes.get(childList.nodeId);
    if (!record) return 'resource-conflict';
    const expectedToken = direction === 'undo' ? childList.afterToken : childList.beforeToken;
    if (readCell<readonly NodeId[]>(record, 'children').token !== expectedToken) {
      return 'resource-conflict';
    }
    const candidate = [...readCell<readonly NodeId[]>(record, 'children').value];
    const ordered = direction === 'undo' ? [...childList.splices].reverse() : childList.splices;
    for (const splice of ordered) {
      const expectedIds = direction === 'undo' ? splice.insertedIds : splice.removedIds;
      const replacementIds = direction === 'undo' ? splice.removedIds : splice.insertedIds;
      if (
        !sameValue(candidate.slice(splice.index, splice.index + expectedIds.length), expectedIds)
      ) {
        return 'resource-conflict';
      }
      candidate.splice(splice.index, expectedIds.length, ...replacementIds);
    }
  }
  for (const birth of patch.births) {
    const record = nodes.get(birth.nodeId);
    if (!record) return 'resource-conflict';
    const patchedFields = patchedBirthFields.get(birth.nodeId);
    for (const field of CELL_FIELDS) {
      if (patchedFields?.has(field)) continue;
      const actual = snapshotCell(record, field);
      const expected = birth.cells[field];
      if (actual.token !== expected.token || !sameValue(actual.value, expected.value)) {
        return 'resource-conflict';
      }
    }
  }
  for (const visibility of patch.visibility) {
    const expected = direction === 'undo' ? visibility.after : visibility.before;
    if (currentActive(state, visibility.nodeId) !== expected) return 'visibility-conflict';
  }
  for (const resource of patch.bornTapes) {
    const tape = tapeMap(state).get(resource.tapeId);
    if (!tape || sharedTypeId(tape) !== resource.sharedTypeId) return 'resource-conflict';
  }
  const liveMarkers = markerItems(state);
  for (const resource of patch.bornMarkers) {
    const marker = liveMarkers.get(resource.boundaryId);
    if (marker?.tapeId !== resource.tapeId || marker.itemId !== resource.itemId)
      return 'resource-conflict';
  }
  return undefined;
}
