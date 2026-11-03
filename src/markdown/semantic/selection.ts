import type { NodeId, TextAffinity } from './types.js';

export interface TextPoint {
  readonly nodeId: NodeId;
  readonly offset: number;
  readonly affinity: TextAffinity;
}

interface TextSelection {
  readonly anchor: TextPoint;
  readonly focus: TextPoint;
}

export interface BlockSelection {
  readonly nodeIds: readonly NodeId[];
  readonly anchor: TextPoint;
  readonly focus: TextPoint;
}

export type EditSelection = TextSelection | BlockSelection;

export type SelectionIntent =
  | { readonly type: 'clear' }
  | {
      readonly type: 'preserve-block-selection';
      readonly selection: BlockSelection;
      readonly restoreOnRedo?: boolean;
    };
