import type * as Y from 'yjs';
import type { NodeId, NodeKind } from '../semantic/types.js';

export type TapeId = string;
export type BoundaryId = string;
export type ResourceToken = string;

export interface Cell<T> {
  readonly token: ResourceToken;
  readonly value: T;
}

export interface Span {
  readonly tapeId: TapeId;
  readonly startBoundaryId: BoundaryId;
  readonly endBoundaryId: BoundaryId;
}

export interface BoundaryEmbed {
  readonly grainBoundary: BoundaryId;
}

export interface CanonicalNodeFields {
  readonly kind: Cell<NodeKind>;
  readonly children: Y.Array<NodeId>;
  readonly childrenToken: ResourceToken;
  readonly spans: Cell<readonly Span[]>;
  readonly marker: Cell<string | null>;
  readonly checked: Cell<boolean | null>;
  readonly info: Cell<string | null>;
}
