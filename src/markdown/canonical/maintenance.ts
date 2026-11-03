import * as Y from 'yjs';

import { encodeCanonicalCheckpoint, openMaintenanceCheckpoint } from './checkpoint.js';
import { importCanonicalTree } from './import-tree.js';
import {
  CONTAINER_KINDS,
  INLINE_KINDS,
  META,
  NODES,
  SCHEMA_VERSION,
  isAllowedChild,
  nodeCell,
  nodeKind,
  readChildren,
  readSpans,
  schemaMap,
} from './schema.js';
import { spanText } from './state-access.js';
import type { CanonicalCheckpoint, CanonicalMaintenanceResult } from './document-types.js';
import type { NodeId } from '../semantic/types.js';
import type { MutableSemanticNode } from './import-tree.js';

type RecordMap = Y.Map<unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function metaValue<T>(state: Y.Doc, key: string): T {
  return schemaMap<unknown>(state, META).get(key) as T;
}

/** Rebuild or migrate accepted state, retaining semantic node IDs and resetting native identity. */
export function rebuildCanonicalCheckpoint(
  checkpoint: CanonicalCheckpoint,
  expectedSchemaVersion: number,
  authorityEpoch: string,
): CanonicalMaintenanceResult {
  assert(
    typeof authorityEpoch === 'string' && authorityEpoch.length > 0,
    'authority epoch cannot be empty',
  );
  assert(
    authorityEpoch !== checkpoint.authorityEpoch,
    'maintenance authority epoch must differ from the checkpoint epoch',
  );
  const source = openMaintenanceCheckpoint(checkpoint, expectedSchemaVersion);
  let rebuilt: Y.Doc | undefined;
  try {
    const nodes = schemaMap<RecordMap>(source, NODES);
    const rootId = metaValue<NodeId>(source, 'rootId');
    const preservedNodeIds: NodeId[] = [];
    const copyNode = (id: NodeId): MutableSemanticNode => {
      const record = nodes.get(id);
      assert(record, `maintenance source is missing node ${id}`);
      const type = nodeKind(record);
      const semantic: MutableSemanticNode = { type };
      preservedNodeIds.push(id);
      if (INLINE_KINDS.has(type)) {
        semantic.content = readSpans(record)
          .map((span) => spanText(source, span))
          .join('');
      }
      if (type === 'section' || type === 'list-item' || type === 'block-quote') {
        semantic.marker = nodeCell<string | null>(record, 'marker') ?? '';
      }
      if (type === 'list-item') {
        const checked = nodeCell<boolean | null>(record, 'checked');
        if (checked !== null) semantic.checked = checked;
      }
      if (type === 'code-block') semantic.info = nodeCell<string | null>(record, 'info');
      if (CONTAINER_KINDS.has(type) || type === 'list') {
        const children = readChildren(record);
        semantic.children = children.map((childId) => {
          const child = nodes.get(childId);
          assert(child, `maintenance source is missing child ${childId}`);
          const childType = nodeKind(child);
          assert(
            isAllowedChild(type, childType),
            `maintenance source has invalid child ${childType} under ${type}`,
          );
          return copyNode(childId);
        });
      }
      return semantic;
    };

    const tree = copyNode(rootId);
    const reserved = new Set<string>([checkpoint.documentId, ...preservedNodeIds]);
    let nodeOrdinal = 0;
    let freshOrdinal = 0;
    rebuilt = importCanonicalTree(tree, {
      documentId: checkpoint.documentId,
      authorityEpoch,
      normalizationVersion: checkpoint.normalizationVersion,
      actionId: `maintenance:${authorityEpoch}`,
      makeId(role) {
        if (role === 'node') {
          const id = preservedNodeIds[nodeOrdinal++];
          assert(id, 'maintenance rebuild allocated more nodes than it preserved');
          return id;
        }
        let id: string;
        do {
          id = `maintenance:${authorityEpoch}:${role}:${freshOrdinal++}`;
        } while (reserved.has(id));
        reserved.add(id);
        return id;
      },
    });
    assert(nodeOrdinal === preservedNodeIds.length, 'maintenance rebuild omitted a preserved node');
    const rebuiltCheckpoint = encodeCanonicalCheckpoint(rebuilt);
    assert(
      rebuiltCheckpoint.schemaVersion === SCHEMA_VERSION,
      'maintenance rebuild emitted the wrong schema',
    );
    return Object.freeze({
      checkpoint: rebuiltCheckpoint,
      reset: Object.freeze({
        oldSchemaVersion: checkpoint.schemaVersion,
        schemaVersion: rebuiltCheckpoint.schemaVersion,
        oldAuthorityEpoch: checkpoint.authorityEpoch,
        authorityEpoch,
        documentId: checkpoint.documentId,
        rootId,
        preservedNodeIds: Object.freeze([...preservedNodeIds]),
        invalidated: Object.freeze([
          'nativeIdentities',
          'history',
          'pendingActions',
          'sessionWatermarks',
          'receipts',
          'selectionAnchors',
        ] as const),
      }),
    });
  } finally {
    source.destroy();
    rebuilt?.destroy();
  }
}
