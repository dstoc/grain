import type { NodeId } from '../semantic/types.js';

export interface CanonicalCheckpoint {
  readonly documentId: string;
  readonly schemaVersion: number;
  readonly normalizationVersion: number;
  readonly authorityEpoch: string;
  readonly acceptedRevision: number;
  readonly update: Uint8Array;
}

export interface CanonicalDocumentOptions {
  readonly documentId?: string;
  readonly authorityEpoch?: string;
  readonly normalizationVersion?: number;
  readonly actionId?: string;
  readonly makeId?: (role: string, ordinal: number) => string;
}

export interface CanonicalOpenOptions {
  readonly normalizationVersion?: number;
}

export interface AcceptedUpdate {
  readonly revision: number;
  readonly update: Uint8Array;
}

export interface CanonicalMaintenanceReset {
  readonly oldSchemaVersion: number;
  readonly schemaVersion: number;
  readonly oldAuthorityEpoch: string;
  readonly authorityEpoch: string;
  readonly documentId: string;
  readonly rootId: NodeId;
  readonly preservedNodeIds: readonly NodeId[];
  readonly invalidated: readonly [
    'nativeIdentities',
    'history',
    'pendingActions',
    'sessionWatermarks',
    'receipts',
    'selectionAnchors',
  ];
}

export interface CanonicalMaintenanceResult {
  readonly checkpoint: CanonicalCheckpoint;
  readonly reset: CanonicalMaintenanceReset;
}
