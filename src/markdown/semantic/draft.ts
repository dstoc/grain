import type { TextPoint } from './selection.js';
import type {
  CreateNodeSpec,
  InlineNodeKind,
  NodeId,
  NodeKind,
  TextAffinity,
  TextEdit,
} from './types.js';

declare const inlineFragmentBrand: unique symbol;

export type DraftNode =
  | (DraftNodeFields & { readonly type: InlineNodeKind; readonly content: string })
  | (DraftNodeFields & { readonly type: 'document' | 'list'; readonly content?: never })
  | (DraftNodeFields & { readonly type: 'list-item' | 'block-quote'; readonly content?: never });

interface DraftNodeFields {
  readonly id: NodeId;
  readonly children: readonly NodeId[];
  readonly marker: string | null;
  readonly checked: boolean | null;
  readonly info: string | null;
}

export interface SemanticDraftNode {
  readonly id: NodeId;
  readonly type: NodeKind;
  readonly children: readonly NodeId[];
  readonly marker: string | null;
  readonly checked: boolean | null;
}

/** The small read and mutation capability needed by the shared normalizer. */
export interface SemanticNormalizationDraft {
  node(id: NodeId): SemanticDraftNode;
  parentOf(id: NodeId): NodeId | undefined;
  previousSiblingOf(id: NodeId): NodeId | undefined;
  nextSiblingOf(id: NodeId): NodeId | undefined;
  create(spec: CreateNodeSpec): NodeId;
  place(id: NodeId, parent: NodeId, before: NodeId | null): void;
  detach(id: NodeId): void;
  setMarker(id: NodeId, marker: string | null): void;
  setChecked(id: NodeId, checked: boolean | null): void;
}

/** A draft-local, move-only fragment. Its text is inspection-only. */
export interface InlineFragment {
  readonly text: string;
  readonly [inlineFragmentBrand]: true;
}

export interface Transfer {
  readonly source: NodeId;
  readonly from: number;
  readonly to: number;
  readonly destination: NodeId;
  /** Destination coordinate in the pre-transfer value, including same-node moves. */
  readonly at: number;
  readonly affinity: TextAffinity;
}

export interface ConversionPlan {
  readonly type: InlineNodeKind;
  readonly marker?: string;
  readonly info?: string | null;
  readonly content?:
    | { readonly mode: 'preserve' }
    | { readonly mode: 'replace'; readonly text: string };
}

export interface TreeDraft extends SemanticNormalizationDraft {
  node(id: NodeId): DraftNode;
  create(spec: CreateNodeSpec): NodeId;
  spliceText(id: NodeId, edit: TextEdit): void;
  cutInline(id: NodeId, from: number, to: number): InlineFragment;
  insertFragment(
    destination: NodeId,
    at: number,
    affinity: TextAffinity,
    fragment: InlineFragment,
  ): void;
  transferInlineRange(transfer: Transfer): void;
  convertInline(id: NodeId, plan: ConversionPlan): void;
  setInfo(id: NodeId, info: string | null): void;
  bookmark(id: NodeId, offset: number, affinity: TextAffinity): TextPoint;
}

export interface DraftTextPiece {
  /** Half-open UTF-16 coordinates in the current draft string. */
  readonly from: number;
  readonly to: number;
  readonly kind: 'existing' | 'inserted';
}

/** Parser conversion reads source mapping before changing ownership. */
export interface ParserTreeDraft extends TreeDraft {
  sourcePieces(id: NodeId): readonly DraftTextPiece[];
}
