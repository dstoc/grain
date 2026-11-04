export { projectMarkdown, projectionDocument, serializeProjection } from './project.js';
export type { ProjectionInput } from './project.js';
export { normalizeProjection } from './normalize.js';
export { selectInterpretations, ProjectionError } from './interpretation.js';
export type { Interpretations, PresentedProperties } from './interpretation.js';
export { prepareParserConversion, bindParserConversion } from './parser-plan.js';
export type {
  SourceFragment,
  OutputBinding,
  PreparedPiece,
  PreparedOutput,
  PreparedConversion,
  BoundConversion,
} from './parser-plan.js';
export {
  selectionRanges,
  textPoint,
  wrapperBoundary,
  deletionTargets,
  resolveAddress,
  requestEmptyRootEdit,
  nativePointIndex,
} from './addresses.js';
export type {
  TextPoint,
  AddressResolution,
  EmptyRootRequest,
  WrapperBoundaryAddress,
} from './addresses.js';
export type {
  ViewNode,
  ProjectionView,
  TextFragment,
  TextBoundary,
  WrapperOrigin,
  BirthContent,
} from './types.js';
export { createProjectionAuthorValidator } from './validation.js';
