import type { Span, ResourceToken, TapeId } from '../canonical-model.js';
import type { TreeDraft } from '../semantic/draft.js';
import type { CreateNodeSpec, NodeId, TextAffinity, TextEdit } from '../semantic/types.js';
import type { ConversionPlan, Transfer } from '../semantic/draft.js';

export type { DraftNode, TreeDraft } from '../semantic/draft.js';
export type {
  ConversionPlan,
  DraftTextPiece,
  InlineFragment,
  ParserTreeDraft,
  Transfer,
} from '../semantic/draft.js';
export type { CreateNodeSpec as NodeSpec } from '../semantic/types.js';

export type CellField = 'kind' | 'children' | 'spans' | 'marker' | 'checked' | 'info';

export interface Bookmark {
  readonly nodeId: NodeId;
  readonly offset: number;
  readonly affinity: TextAffinity;
  /** Canonical-only hint for a boundary between identity-preserving spans. */
  readonly spanIndex?: number;
}

export interface CanonicalTextAnchor {
  readonly bookmark: Bookmark;
  readonly tapeId: TapeId;
  readonly relativePosition: readonly number[];
  readonly previousNodeId?: NodeId;
  readonly nextNodeId?: NodeId;
}

export interface ActionFocus {
  readonly start?: Bookmark;
  readonly end?: Bookmark;
  readonly selection?: {
    readonly anchor: Bookmark;
    readonly focus: Bookmark;
    /** Restore this identity-preserving structural selection after redo as well. */
    readonly restoreOnRedo?: boolean;
  };
}

export type DraftCommand = (draft: TreeDraft) => void | ActionFocus;

export type ReadPrecondition =
  | {
      readonly kind: 'cell';
      readonly nodeId: NodeId;
      readonly field: CellField;
      readonly token: string;
    }
  | { readonly kind: 'tape'; readonly tapeId: TapeId; readonly revision: number };

export type SemanticOperation =
  | {
      readonly type: 'create';
      readonly id: NodeId;
      readonly spec: CreateNodeSpec;
      readonly span?: Span;
    }
  | {
      readonly type: 'place';
      readonly id: NodeId;
      readonly parent: NodeId;
      readonly before: NodeId | null;
    }
  | { readonly type: 'detach'; readonly id: NodeId }
  | { readonly type: 'spliceText'; readonly id: NodeId; readonly edit: TextEdit }
  | {
      readonly type: 'cutInline';
      readonly id: NodeId;
      readonly from: number;
      readonly to: number;
      readonly fragmentId: string;
    }
  | {
      readonly type: 'insertFragment';
      readonly destination: NodeId;
      readonly at: number;
      readonly affinity: TextAffinity;
      readonly fragmentId: string;
    }
  | {
      readonly type: 'transferInlineRange';
      readonly transfer: Transfer;
    }
  | {
      readonly type: 'convertInline';
      readonly id: NodeId;
      readonly plan: ConversionPlan;
    }
  | { readonly type: 'setMarker'; readonly id: NodeId; readonly marker: string | null }
  | { readonly type: 'setChecked'; readonly id: NodeId; readonly checked: boolean | null }
  | { readonly type: 'setInfo'; readonly id: NodeId; readonly info: string | null };

export interface ActionRequest {
  readonly mode: 'text-input' | 'command';
  readonly documentId: string;
  readonly authorityEpoch: string;
  readonly sessionId: string;
  readonly sessionSequence: number;
  readonly actionId: string;
  readonly baseRevision: number;
  readonly historyGroupId: string;
  readonly preconditions: readonly ReadPrecondition[];
  /** Internal trusted Grain-engine input; not an arbitrary-update security filter. */
  readonly textUpdate?: Uint8Array;
  readonly operations: readonly SemanticOperation[];
  readonly focus?: ActionFocus;
  readonly promotionTarget?: {
    readonly nodeId: NodeId;
    readonly kindToken: ResourceToken;
    readonly spansToken: ResourceToken;
  };
}

export interface ActionOptions {
  readonly sessionId?: string;
  /** Unique across the lifetime of the canonical document's authority. */
  readonly actionId: string;
  readonly historyGroupId?: string;
  readonly sessionSequence?: number;
  readonly focus?: ActionFocus;
}

export interface AdmittedContext {
  readonly sessionId: string;
  readonly authorityEpoch: string;
  readonly sessionSequence: number;
}

export interface AcceptedAction {
  readonly actionId: string;
  readonly sessionId: string;
  readonly authorityEpoch: string;
  readonly revision: number;
  readonly update: Uint8Array;
  readonly receipt: ActionReceipt;
  readonly callbackErrors: readonly unknown[];
}

export interface ActionReceipt {
  readonly requestId: string;
  readonly historyGroupId: string;
  readonly touchedNodeIds: readonly NodeId[];
  readonly touchedTapeIds: readonly TapeId[];
  readonly structuralPatch: StructuralPatch;
  readonly focus?: ActionFocus;
  readonly noEffect: boolean;
  readonly promotionSkipped?: 'ownershipChanged';
}

export interface StructuralCellValue {
  readonly token: ResourceToken;
  readonly value: unknown;
}

export interface StructuralCellPatch {
  readonly nodeId: NodeId;
  readonly field: CellField;
  readonly before: StructuralCellValue;
  readonly after: StructuralCellValue;
}

export interface StructuralChildSplice {
  /** Index in the child list immediately before this splice. */
  readonly index: number;
  readonly removedIds: readonly NodeId[];
  readonly insertedIds: readonly NodeId[];
}

export interface StructuralChildListPatch {
  readonly nodeId: NodeId;
  readonly beforeToken: ResourceToken;
  readonly afterToken: ResourceToken;
  readonly splices: readonly StructuralChildSplice[];
}

export interface StructuralBirth {
  readonly nodeId: NodeId;
  readonly cells: Readonly<Record<CellField, StructuralCellValue>>;
}

export interface StructuralVisibility {
  readonly nodeId: NodeId;
  readonly before: boolean;
  readonly after: boolean;
}

export interface StructuralPatch {
  readonly cells: readonly StructuralCellPatch[];
  readonly childLists: readonly StructuralChildListPatch[];
  readonly births: readonly StructuralBirth[];
  readonly visibility: readonly StructuralVisibility[];
  readonly bornTapes: readonly { readonly tapeId: TapeId; readonly sharedTypeId: string }[];
  readonly bornMarkers: readonly {
    readonly tapeId: TapeId;
    readonly boundaryId: string;
    readonly itemId: string;
  }[];
}

export interface PendingCommit {
  readonly actionId: string;
  readonly revision: number;
  readonly update: Uint8Array;
  readonly receipt: ActionReceipt;
}

export type ApplyResult =
  | { readonly status: 'pending'; readonly pending: PendingCommit }
  | { readonly status: 'rejected'; readonly reason: RejectionReason }
  | { readonly status: 'duplicate'; readonly accepted: AcceptedAction }
  | { readonly status: 'queued'; readonly actionId: string };

export type RejectionReason =
  | 'pending-commit'
  | 'poisoned-writer'
  | 'closed-writer'
  | 'wrong-document'
  | 'wrong-authority-epoch'
  | 'wrong-session'
  | 'wrong-sequence'
  | 'future-base-revision'
  | 'stale-precondition'
  | 'duplicate-action-id'
  | 'retry-payload-conflict'
  | 'receipt-expired/resync-required'
  | 'invalid-request'
  | 'invalid-operation'
  | 'invalid-text-update'
  | 'publication-order';

export interface WriterOptions {
  readonly maxHistoryGroups?: number;
  /** Full-document before/after validation retained as an opt-in test reference. */
  readonly verifyWithFullClone?: boolean;
}

export interface WriterOperationCounts {
  readonly fullStateClones: number;
  readonly authorReplicaCreations: number;
  readonly validationReplicaCreations: number;
  readonly literalTextInputs: number;
}

export interface HistoryResult {
  readonly status: 'applied' | 'no-effect' | 'blocked' | 'empty' | 'history-reset' | 'queued';
  readonly revision?: number;
  readonly update?: Uint8Array;
  readonly textChanged?: boolean;
  readonly focus?: Bookmark;
  readonly focusAnchor?: CanonicalTextAnchor;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
  readonly reason?:
    | 'structural-history-pending'
    | 'resource-conflict'
    | 'visibility-conflict'
    | 'invalid-inverse'
    | 'mixed-scope'
    | 'invalid-scope';
  readonly callbackErrors?: readonly unknown[];
}

export interface PendingHistoryCommit {
  readonly sessionId: string;
  readonly direction: 'undo' | 'redo';
  readonly revision: number;
  readonly textChanged: boolean;
  readonly focus?: Bookmark;
  readonly focusAnchor?: CanonicalTextAnchor;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
  /** Returns a defensive copy for persistence before publication. */
  readonly update: Uint8Array;
}

export type HistoryPreparationResult =
  | { readonly status: 'pending'; readonly pending: PendingHistoryCommit }
  | HistoryResult;

export interface WriterEvent {
  readonly type: 'commit' | 'history';
  readonly actionId?: string;
  readonly revision?: number;
}

export type WriterListener = (event: WriterEvent) => void;
