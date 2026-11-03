export {
  CanonicalDocument,
  CanonicalNode,
  assertRetainedResources,
  assertTapeRevisions,
  canonicalWriterAccess,
  tapeItemSignature,
  validateActiveSpans,
  validateCanonicalState,
  validateRetainedForest,
} from './canonical/document.js';
export type {
  AcceptedUpdate,
  CanonicalCheckpoint,
  CanonicalDocumentOptions,
  CanonicalMaintenanceResult,
  CanonicalOpenOptions,
  CanonicalWriterAccess,
  NodeId,
  NodeKind,
  ValidationResult,
} from './canonical/document.js';
export type {
  BoundaryEmbed,
  BoundaryId,
  CanonicalNodeFields,
  Cell,
  ResourceToken,
  Span,
  TapeId,
} from './canonical/types.js';
