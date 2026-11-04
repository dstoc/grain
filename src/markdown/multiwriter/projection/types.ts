import type { MarkdownNode } from '../../node.js';
import type {
  BlockSlot,
  InlineSlot,
  NativeTextRange,
  NodeId,
  ProjectionAddress,
  RangeRef,
} from '../contracts.js';

export interface TextFragment {
  readonly text: string;
  readonly range: NativeTextRange;
  readonly address: Extract<ProjectionAddress, { type: 'text' }>;
  readonly visible: boolean;
  readonly masked: boolean;
}
export interface TextBoundary {
  readonly offset: number;
  readonly address: Extract<ProjectionAddress, { type: 'text' }>;
}
export interface WrapperOrigin {
  readonly node: NodeId;
  readonly edge: Extract<ProjectionAddress, { type: 'edge' }>;
  /** Original insertion gaps, including retained hidden/ineffective predecessor slots. */
  readonly start: BlockSlot;
  readonly end: BlockSlot;
}
export interface ViewNode {
  /** Existing representative identity; grouping never creates a shared ID. */
  readonly origin: Extract<ProjectionAddress, { type: 'node' }>;
  readonly edge: Extract<ProjectionAddress, { type: 'edge' }> | null;
  readonly type: MarkdownNode['type'];
  readonly marker: string | null;
  readonly info: string | null;
  readonly checked: boolean | null;
  readonly content: string;
  readonly children: readonly ViewNode[];
  /** Includes hidden characters for explicit demotion and exact selection mapping. */
  readonly fragments: readonly TextFragment[];
  readonly boundaries: readonly TextBoundary[];
  readonly wrappers: readonly WrapperOrigin[];
}
export interface ProjectionView {
  readonly root: ViewNode;
  readonly emptyRoot: Extract<ProjectionAddress, { type: 'empty-root' }> | null;
}
export interface BirthContent {
  readonly node: NodeId;
  /** MW-05 birth-causal coverage, never recomputed from current ownership. */
  readonly intervals: readonly RangeRef[];
}
export interface MutableViewNode {
  origin: { type: 'node'; representative: NodeId; constituents: NodeId[] };
  edge: Extract<ProjectionAddress, { type: 'edge' }> | null;
  type: MarkdownNode['type'];
  marker: string | null;
  info: string | null;
  checked: boolean | null;
  content: string;
  children: MutableViewNode[];
  fragments: TextFragment[];
  boundaries: TextBoundary[];
  wrappers: WrapperOrigin[];
}
export function textOrigin(
  slot: InlineSlot,
  origin: RangeRef,
): Extract<ProjectionAddress, { type: 'text' }> {
  return { type: 'text', slot, origin };
}
