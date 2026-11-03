import type { CellValue } from '../state-access.js';
import type { NativeTapeIndex, NativeTextRun } from '../../canonical-text.js';
import type { Span, TapeId } from '../types.js';
import type { NodeId, NodeKind, TextAffinity } from '../../semantic/types.js';
import type { CellField, SemanticOperation } from '../action-types.js';

export interface InternalCell {
  readonly token: string;
  readonly value: unknown;
}

export interface InsertionSlot {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly spanIndex: number;
  readonly affinity: TextAffinity;
  readonly order: number;
}

export type InsertionSlotTarget = Omit<InsertionSlot, 'order'> & {
  /** Preserve the source buffer gap when an edit follows a transfer. */
  readonly parentBufferId?: string;
  readonly parentBufferOffset?: number;
};

interface ExistingPiece {
  readonly kind: 'existing';
  readonly source: NodeId;
  readonly tapeId: TapeId;
  readonly sourceSpanIndex: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export interface InsertedPiece {
  readonly kind: 'inserted';
  readonly bufferId: string;
  readonly from: number;
  readonly to: number;
  readonly anchor: InsertionSlot;
  readonly text: string;
}

export interface DraftTextBuffer {
  readonly text: string;
  readonly anchor: InsertionSlot;
  readonly parentBufferId?: string;
  readonly parentBufferOffset?: number;
}

export type DraftPiece = ExistingPiece | InsertedPiece;

export interface DraftSpan {
  span: Span;
  pieces: DraftPiece[];
  readonly sourceSpanIndex?: number;
  readonly created?: boolean;
  /** Insertion target retained when a cut leaves this span empty. */
  readonly insertionSlot?: InsertionSlotTarget;
}

export interface DraftNodeState {
  readonly id: NodeId;
  type: NodeKind;
  children: NodeId[];
  spans: DraftSpan[];
  marker: string | null;
  checked: boolean | null;
  info: string | null;
  readonly baseCells: Map<CellField, InternalCell>;
  readonly created: boolean;
  textEdited: boolean;
}

export interface DraftFragment {
  readonly spans: readonly DraftSpan[];
  readonly text: string;
}

export interface PlanBoundary {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly boundaryId: string;
  /** Position inside action-local text inserted at this native index. */
  readonly insertionOffset: number;
  readonly side: 'start' | 'end';
  readonly order: number;
  /** Action-local buffer that defines this transfer boundary's slot. */
  readonly sourceBufferId?: string;
  /** UTF-16 offset in the immutable action-local buffer. */
  readonly sourceBufferOffset?: number;
}

export interface PlanTextInsert {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly slotOrder: number;
  readonly text: string;
}

export interface PlanNodeAllocation {
  readonly id: NodeId;
  readonly type: NodeKind;
  readonly marker: string | null;
  readonly checked: boolean | null;
  readonly info: string | null;
  readonly spans: readonly Span[];
  readonly cells: Readonly<Record<CellField, CellValue<unknown>>>;
}

export interface LowLevelPlan {
  readonly allocations: readonly PlanNodeAllocation[];
  readonly newTapes: readonly { readonly id: TapeId; readonly span: Span }[];
  readonly boundaries: readonly PlanBoundary[];
  readonly deletions: readonly NativeTextRun[];
  readonly insertions: readonly PlanTextInsert[];
  readonly writes: readonly {
    readonly nodeId: NodeId;
    readonly field: CellField;
    readonly value: unknown;
    readonly token: string;
  }[];
  readonly touchedNodes: readonly NodeId[];
  readonly touchedTapes: readonly TapeId[];
  readonly textTapes: readonly TapeId[];
}

interface CompilationDraftSpan {
  readonly span: Span;
  readonly pieces: readonly DraftPiece[];
}

interface CompilationDraftNode {
  readonly id: NodeId;
  readonly type: NodeKind;
  readonly children: readonly NodeId[];
  readonly spans: readonly CompilationDraftSpan[];
  readonly marker: string | null;
  readonly checked: boolean | null;
  readonly info: string | null;
  readonly baseCells: ReadonlyMap<CellField, InternalCell>;
  readonly created: boolean;
  readonly textEdited: boolean;
}

/** Closed, read-only inputs captured once after all draft edits have settled. */
export interface DraftCompilationSnapshot {
  readonly nodes: readonly CompilationDraftNode[];
  readonly operations: readonly SemanticOperation[];
  readonly newTapeSpans: ReadonlyMap<NodeId, Span>;
  readonly transferBoundaries: readonly PlanBoundary[];
  readonly textBuffers: ReadonlyMap<string, DraftTextBuffer>;
  readonly textIndexes: ReadonlyMap<TapeId, NativeTapeIndex>;
  readonly baseTextByNode: ReadonlyMap<NodeId, readonly string[]>;
  readonly semanticPaths: ReadonlyMap<NodeId, readonly number[] | undefined>;
  readonly allocateCellToken: () => string;
}
