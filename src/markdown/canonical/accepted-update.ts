import * as Y from 'yjs';

import {
  META,
  NODES,
  SCHEMA_VERSION,
  SESSION_WATERMARKS,
  TAPES,
  TAPE_REVISIONS,
  schemaMap,
} from './schema.js';
import { validateCanonicalState } from './validation.js';
import type { BoundaryEmbed } from './types.js';

type RecordMap = Y.Map<unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ymap<T>(document: Y.Doc, name: string): Y.Map<T> {
  return schemaMap<T>(document, name);
}

function metaValue<T>(meta: Y.Map<unknown>, key: string): T {
  return meta.get(key) as T;
}

interface YjsItemLike {
  readonly id: { readonly client: number; readonly clock: number };
  readonly right: YjsItemLike | null;
  readonly length: number;
  readonly deleted: boolean;
  readonly content: unknown;
}

interface YjsSharedTypeInternals {
  readonly _item: YjsItemLike | null;
  readonly _start: YjsItemLike | null;
}

function yjsItemId(item: YjsItemLike): string {
  return `${item.id.client}:${item.id.clock}`;
}

function sharedTypeId(type: { readonly _item: YjsItemLike | null }): string {
  const item = (type as unknown as YjsSharedTypeInternals)._item;
  assert(item, 'canonical shared type is not integrated');
  return yjsItemId(item);
}

function retainedMarkers(
  tape: Y.Text,
): readonly { readonly itemId: string; readonly boundaryId: string }[] {
  const markers: { itemId: string; boundaryId: string }[] = [];
  let item = (tape as unknown as YjsSharedTypeInternals)._start;
  while (item) {
    const content = item.content;
    const embed =
      content !== null && typeof content === 'object' && 'embed' in content
        ? (content as { readonly embed: unknown }).embed
        : undefined;
    if (
      !item.deleted &&
      embed !== null &&
      typeof embed === 'object' &&
      'grainBoundary' in embed &&
      typeof (embed as BoundaryEmbed).grainBoundary === 'string'
    ) {
      markers.push({ itemId: yjsItemId(item), boundaryId: (embed as BoundaryEmbed).grainBoundary });
    }
    item = item.right;
  }
  return markers;
}

export function tapeItemSignature(tape: Y.Text): string {
  const items: [string, number, boolean][] = [];
  let item = (tape as unknown as YjsSharedTypeInternals)._start;
  while (item) {
    items.push([yjsItemId(item), item.length, item.deleted]);
    item = item.right;
  }
  return JSON.stringify(items);
}

/** @internal Verify that accepted writes retain every integrated permanent Yjs type. */
export function assertRetainedResources(previous: Y.Doc, candidate: Y.Doc): void {
  const previousMeta = ymap<unknown>(previous, META);
  const candidateMeta = ymap<unknown>(candidate, META);
  const rootId = metaValue<string>(previousMeta, 'rootId');
  assert(
    metaValue<string>(candidateMeta, 'rootId') === rootId,
    'accepted update changed the fixed root ID',
  );

  const previousNodes = ymap<RecordMap>(previous, NODES);
  const candidateNodes = ymap<RecordMap>(candidate, NODES);
  for (const [id, record] of previousNodes.entries()) {
    const next = candidateNodes.get(id);
    assert(next instanceof Y.Map, `accepted update removed permanent node ${id}`);
    assert(
      sharedTypeId(next) === sharedTypeId(record),
      `accepted update replaced the native record for node ${id}`,
    );
    const previousChildren = record.get('children');
    const candidateChildren = next.get('children');
    if (previousChildren instanceof Y.Array) {
      assert(candidateChildren instanceof Y.Array, `accepted update replaced children array ${id}`);
      assert(
        sharedTypeId(candidateChildren) === sharedTypeId(previousChildren),
        `accepted update replaced the native children array for node ${id}`,
      );
    }
  }

  const previousTapes = ymap<Y.Text>(previous, TAPES);
  const candidateTapes = ymap<Y.Text>(candidate, TAPES);
  for (const [id, tape] of previousTapes.entries()) {
    const next = candidateTapes.get(id);
    assert(next instanceof Y.Text, `accepted update removed permanent tape ${id}`);
    assert(
      sharedTypeId(next) === sharedTypeId(tape),
      `accepted update replaced the native tape for ${id}`,
    );

    const nextMarkers = retainedMarkers(next);
    let markerIndex = 0;
    for (const marker of retainedMarkers(tape)) {
      const nextIndex = nextMarkers.findIndex(
        (candidateMarker, index) =>
          index >= markerIndex &&
          candidateMarker.itemId === marker.itemId &&
          candidateMarker.boundaryId === marker.boundaryId,
      );
      assert(
        nextIndex >= markerIndex,
        `accepted update deleted, replaced, or reordered retained boundary ${marker.boundaryId}`,
      );
      markerIndex = nextIndex + 1;
    }
  }

  const previousRevisions = ymap<number>(previous, TAPE_REVISIONS);
  const candidateRevisions = ymap<number>(candidate, TAPE_REVISIONS);
  for (const tapeId of previousRevisions.keys()) {
    assert(
      candidateRevisions.has(tapeId),
      `accepted update removed permanent tape revision ${tapeId}`,
    );
  }
}

export function assertTapeRevisions(previous: Y.Doc, candidate: Y.Doc, revision: number): void {
  const previousTapes = ymap<Y.Text>(previous, TAPES);
  const candidateTapes = ymap<Y.Text>(candidate, TAPES);
  const previousRevisions = ymap<number>(previous, TAPE_REVISIONS);
  const candidateRevisions = ymap<number>(candidate, TAPE_REVISIONS);

  for (const [tapeId, tape] of candidateTapes.entries()) {
    const currentRevision = candidateRevisions.get(tapeId);
    assert(
      Number.isSafeInteger(currentRevision) && currentRevision! >= 0,
      `tape ${tapeId} has an invalid revision`,
    );
    const previousTape = previousTapes.get(tapeId);
    const changed =
      previousTape === undefined || tapeItemSignature(previousTape) !== tapeItemSignature(tape);
    if (changed) {
      assert(
        currentRevision === revision,
        `tape ${tapeId} changed without recording accepted revision ${revision}`,
      );
    } else {
      assert(
        currentRevision === previousRevisions.get(tapeId),
        `tape ${tapeId} revision changed without modifying the tape`,
      );
    }
    assert(currentRevision! <= revision, `tape ${tapeId} revision is ahead of accepted state`);
  }
}

function assertSessionWatermarkProgress(previous: Y.Doc, candidate: Y.Doc): void {
  const before = ymap<number>(previous, SESSION_WATERMARKS);
  const after = ymap<number>(candidate, SESSION_WATERMARKS);
  const changed: string[] = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const oldValue = before.get(key) ?? 0;
    const newValue = after.get(key) ?? 0;
    assert(
      Number.isSafeInteger(oldValue) &&
        oldValue >= 0 &&
        Number.isSafeInteger(newValue) &&
        newValue >= 0,
      `session watermark ${key} is invalid`,
    );
    assert(newValue >= oldValue, `session watermark ${key} moved backwards`);
    if (newValue !== oldValue) {
      assert(newValue === oldValue + 1, `session watermark ${key} skipped a sequence`);
      changed.push(key);
    }
  }
  assert(changed.length <= 1, 'accepted update advanced multiple session watermarks');
}

/** Verify accepted state identity, revision ownership, and the session watermark. */
export function assertAcceptedUpdate(previous: Y.Doc, candidate: Y.Doc, revision: number): void {
  assert(
    !candidate.store.pendingStructs && !candidate.store.pendingDs,
    'accepted update has unresolved native dependencies',
  );
  const beforeMeta = ymap<unknown>(previous, META);
  const candidateMeta = ymap<unknown>(candidate, META);
  assert(
    metaValue<string>(candidateMeta, 'documentId') === metaValue<string>(beforeMeta, 'documentId'),
    'accepted update belongs to another document',
  );
  assert(
    metaValue<string>(candidateMeta, 'authorityEpoch') ===
      metaValue<string>(beforeMeta, 'authorityEpoch'),
    'accepted update belongs to another authority epoch',
  );
  assert(
    metaValue<number>(candidateMeta, 'schemaVersion') === SCHEMA_VERSION,
    'accepted update has an unsupported schema version',
  );
  assert(
    metaValue<number>(candidateMeta, 'normalizationVersion') ===
      metaValue<number>(beforeMeta, 'normalizationVersion'),
    'accepted update has an unsupported normalization version',
  );
  assert(
    metaValue<number>(candidateMeta, 'acceptedRevision') === revision,
    'accepted update has the wrong revision',
  );
  assertRetainedResources(previous, candidate);
  const validation = validateCanonicalState(candidate);
  assert(validation.valid, `accepted update failed validation: ${validation.errors.join('; ')}`);
  assertTapeRevisions(previous, candidate, revision);
  assertSessionWatermarkProgress(previous, candidate);
}
