/** Schema-3 logical contracts. The MW-01 codec owns their deterministic CBOR encoding. */
export const PROTOCOL_VERSION = 3 as const;
export const YJS_VERSION = '13.6.33' as const;
export const MAX_COUNTER = (1n << 64n) - 1n;
export const DEFAULT_HISTORY_LIMIT = 500;
export const ENVELOPE_ENCODING = {
  format: 'deterministic-cbor',
  definiteLengths: true,
  duplicateMapKeys: false,
  floatingPoint: false,
  optionalTags: false,
  counterBits: 64,
} as const;
export const STORAGE_CONTRACT = {
  canonical: 'actionDoc',
  envelopes: 'append-only-array',
  semanticArrayOrder: false,
  synchronizedNativeCache: false,
  nativeDeletion: false,
  nativeFormatting: false,
  nativeUndoManager: false,
} as const;

/** Canonical lowercase hex for 128 random bits; encoded as 16 bytes by the codec. */
export type ActorId = string & { readonly __actorId: unique symbol };
export interface ActionId {
  readonly actor: ActorId;
  readonly sequence: bigint;
}
export interface SessionId {
  readonly actor: ActorId;
  readonly local: string;
}
export interface GroupId {
  readonly session: SessionId;
  readonly sequence: bigint;
}

export type ResourceKind =
  | 'node'
  | 'flow'
  | 'tape'
  | 'marker'
  | 'run'
  | 'occurrence'
  | 'deletion'
  | 'interpretation';
/** Ordinals are unique across all kinds within one action/genesis, never replica-local. */
export interface ResourceId<K extends ResourceKind> {
  readonly kind: K;
  readonly birth:
    | { readonly type: 'genesis'; readonly genesisId: string }
    | { readonly type: 'action'; readonly action: ActionId };
  readonly ordinal: number;
}
export type NodeId = ResourceId<'node'>;
export type FlowId = ResourceId<'flow'>;
export type TapeId = ResourceId<'tape'>;
export type MarkerId = ResourceId<'marker'>;
export type RunId = ResourceId<'run'>;
export type OccurrenceId = ResourceId<'occurrence'>;
export type DeletionId = ResourceId<'deletion'>;
export type InterpretationId = ResourceId<'interpretation'>;

/** Native clocks and lengths count UTF-16 units (or one unit for a boundary embed). */
export interface NativeId {
  readonly client: number;
  readonly clock: number;
}
export interface NativeRange extends NativeId {
  readonly length: number;
}
export interface NativeTextRange extends NativeRange {
  readonly tape: TapeId;
}
export type Affinity = 'left' | 'right';
/** Open interval; later native insertions inside these permanent endpoints are included. */
export interface RangeRef {
  readonly tape: TapeId;
  readonly start: MarkerId;
  readonly end: MarkerId;
}
export interface BlockSlot {
  readonly parent: NodeId;
  readonly predecessor: OccurrenceId | null;
}
export interface InlineSlot {
  readonly run: RunId;
  readonly boundary: MarkerId;
  readonly side: Affinity;
  readonly predecessor: OccurrenceId | null;
}
export interface FlowBasis {
  readonly ranges: readonly {
    readonly range: RangeRef;
    readonly occurrence: OccurrenceId;
  }[];
}
export type RawRole = 'root' | 'list' | 'list-item' | 'quote' | 'inline';
export type InlinePresentation = 'paragraph' | 'section' | 'code';
export interface InlineProperties {
  readonly presentation: InlinePresentation;
  readonly marker: string | null;
  readonly info: string | null;
}
export type Allocation =
  | {
      readonly type: 'node';
      readonly id: NodeId;
      readonly role: RawRole;
      readonly flow: FlowId | null;
      readonly birthSlot: BlockSlot | null;
    }
  | { readonly type: 'flow'; readonly id: FlowId; readonly home: NodeId }
  | {
      readonly type: 'tape';
      readonly id: TapeId;
      readonly start: MarkerId;
      readonly end: MarkerId;
    }
  | {
      readonly type: 'marker';
      readonly id: MarkerId;
      readonly tape: TapeId;
      readonly native: NativeId;
      readonly affinity: Affinity;
    }
  | {
      readonly type: 'run';
      readonly id: RunId;
      readonly flow: FlowId;
      readonly skeleton: readonly RangeRef[];
    }
  | {
      readonly type: 'occurrence';
      readonly id: OccurrenceId;
      readonly slot: BlockSlot | InlineSlot;
    }
  | { readonly type: 'deletion'; readonly id: DeletionId }
  | { readonly type: 'interpretation'; readonly id: InterpretationId };

export type NativeResourceBirth =
  | {
      readonly type: 'text';
      readonly tape: TapeId;
      readonly native: NativeRange;
      readonly text: string;
    }
  | {
      readonly type: 'marker';
      readonly tape: TapeId;
      readonly native: NativeId;
      readonly marker: MarkerId;
    };
/** Captured causal ownership, never recomputed as descendants of the final tree. */
export interface SubtreeDeletionScope {
  readonly target: NodeId;
  readonly observedNodes: readonly NodeId[];
  readonly ownedIntervals: readonly RangeRef[];
  readonly joinedFlows: readonly FlowId[];
  readonly heads: readonly ActionId[];
}
export interface InterpretationPacket {
  readonly id: InterpretationId;
  readonly source: NodeId;
  readonly properties: InlineProperties;
  readonly wrappers: readonly NodeId[];
  readonly placements: readonly {
    readonly node: NodeId;
    readonly occurrence: OccurrenceId;
    readonly slot: BlockSlot;
  }[];
  readonly syntaxMask: readonly NativeTextRange[];
  /** All editable synthesis is born in this action's native insertion manifest. */
  readonly synthesizedText: readonly NativeTextRange[];
  /** Additional inline births and original effect ordinals owned by this conversion. */
  readonly derivedInlineOutputs?: readonly NodeId[];
  readonly effectOrdinals?: readonly number[];
}
export type SemanticEffect =
  | { readonly type: 'InsertText'; readonly ranges: readonly NativeTextRange[] }
  | {
      readonly type: 'MoveBlock';
      readonly node: NodeId;
      readonly occurrence: OccurrenceId;
      readonly slot: BlockSlot;
      /** Inline moves also assert a standalone flow; wrapper moves have no flow. */
      readonly standaloneFlow: FlowId | null;
    }
  | {
      readonly type: 'JoinFlow';
      readonly source: FlowId;
      readonly destination: InlineSlot;
      readonly occurrence: OccurrenceId;
      readonly liftedChildren: readonly NodeId[];
    }
  | {
      readonly type: 'SplitFlow';
      readonly basis: FlowBasis;
      readonly cut: InlineSlot;
      readonly retainedSide: 'left' | 'right';
      readonly newNode: NodeId;
      readonly newFlow: FlowId;
      readonly newRun: RunId;
      readonly occurrence: OccurrenceId;
      readonly outerSlot: BlockSlot;
    }
  | {
      readonly type: 'TransferRange';
      readonly ranges: readonly RangeRef[];
      readonly destination: InlineSlot;
      readonly run: RunId;
      readonly occurrence: OccurrenceId;
    }
  | {
      readonly type: 'DeleteText';
      readonly tag: DeletionId;
      readonly observed: readonly NativeTextRange[];
    }
  | {
      readonly type: 'DeleteSubtree';
      readonly tag: DeletionId;
      readonly scope: SubtreeDeletionScope;
    }
  | { readonly type: 'Interpret'; readonly packet: InterpretationPacket }
  | {
      readonly type: 'SetProperties';
      readonly node: NodeId;
      readonly values: {
        readonly presentation?: InlinePresentation;
        readonly marker?: string | null;
        readonly info?: string | null;
        readonly checked?: boolean | null;
      };
    }
  | {
      readonly type: 'LiftChildren';
      readonly placements: readonly {
        readonly node: NodeId;
        readonly occurrence: OccurrenceId;
        readonly slot: BlockSlot;
      }[];
    }
  | {
      readonly type: 'SetGroupActive';
      readonly group: GroupId;
      readonly actions: readonly ActionId[];
      readonly active: boolean;
      readonly previousControl: ActionId | null;
    };
export interface ActionEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentId: string;
  readonly genesisId: string;
  readonly id: ActionId;
  readonly lamport: bigint;
  readonly dependencies: readonly ActionId[];
  readonly groupId: GroupId;
  readonly allocations: readonly Allocation[];
  readonly nativeInsertUpdates: readonly Uint8Array[];
  readonly nativeManifest: readonly NativeResourceBirth[];
  readonly effects: readonly SemanticEffect[];
}
export type ActionReadiness =
  | { readonly state: 'ready' }
  | { readonly state: 'pending'; readonly missing: readonly ActionId[] }
  | {
      readonly state: 'quarantined';
      readonly reason: 'fork' | 'version' | 'reference' | 'native-body' | 'actor-chain';
    };

/** Local projection addresses always resolve to persistent origins. */
export type ProjectionAddress =
  | {
      readonly type: 'node';
      readonly representative: NodeId;
      readonly constituents: readonly NodeId[];
    }
  | { readonly type: 'edge'; readonly child: NodeId; readonly slot: BlockSlot }
  | { readonly type: 'text'; readonly slot: InlineSlot; readonly origin: RangeRef }
  | { readonly type: 'empty-root'; readonly slot: BlockSlot };
export interface CellAssignment {
  readonly cell: RangeRef;
  readonly occurrence: OccurrenceId;
  readonly run: RunId;
}
export interface RunLayout {
  readonly run: RunId;
  readonly flow: FlowId;
  readonly skeleton: readonly RangeRef[];
}
export interface FlowPlacement {
  readonly flow: FlowId;
  readonly parent:
    | { readonly type: 'block'; readonly node: NodeId }
    | { readonly type: 'flow'; readonly slot: InlineSlot; readonly occurrence: OccurrenceId };
}
export type SyncMode = 'bidirectional' | 'outbound-only' | 'inbound-only' | 'disconnected';
export const SYNC_DIRECTIONS = {
  bidirectional: { send: true, receive: true },
  'outbound-only': { send: true, receive: false },
  'inbound-only': { send: false, receive: true },
  disconnected: { send: false, receive: false },
} as const satisfies Record<SyncMode, { readonly send: boolean; readonly receive: boolean }>;
export type DeliveryRoute = 'peer' | 'catch-up' | 'self-echo' | 'cross-tab';
export interface PublicationStatus {
  readonly applied: boolean;
  readonly persisted: boolean;
  /** Omitted if the transport has no acknowledgment facility. Never means equal views. */
  readonly delivered?: boolean;
}
export interface CheckpointManifest {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentId: string;
  readonly genesisId: string;
  readonly coveredActions: readonly ActionId[];
  readonly heads: readonly ActionId[];
}
export const RETENTION_POLICY = {
  expireOfflineReplicas: false,
  pruneCanonicalFacts: false,
  rewriteGenesisOnCheckpoint: false,
  nativeCacheGc: false,
  localHistoryLimit: DEFAULT_HISTORY_LIMIT,
  evictDerivedCaches: true,
  consolidatePersistenceLosslessly: true,
} as const;

export function actorId(hex: string): ActorId {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('Actor ID must be 128 bits of lowercase hex');
  return hex as ActorId;
}
export function assertCounter(value: bigint): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COUNTER)
    throw new Error('Counter must be an unsigned 64-bit integer');
}
/** Actor IDs are canonical fixed-width hex, so lexical order equals byte order. */
export function compareActions(
  left: Pick<ActionEnvelope, 'lamport' | 'id'>,
  right: Pick<ActionEnvelope, 'lamport' | 'id'>,
): number {
  return (
    compareInteger(left.lamport, right.lamport) ||
    (left.id.actor < right.id.actor ? -1 : left.id.actor > right.id.actor ? 1 : 0) ||
    compareInteger(left.id.sequence, right.id.sequence)
  );
}
export function compareEffects(
  left: { readonly action: Pick<ActionEnvelope, 'lamport' | 'id'>; readonly ordinal: number },
  right: { readonly action: Pick<ActionEnvelope, 'lamport' | 'id'>; readonly ordinal: number },
): number {
  return compareActions(left.action, right.action) || left.ordinal - right.ordinal;
}
function compareInteger(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
