/** A known ownership/layout data invariant failed. Operational readers and
 * provider failures must not be converted into this semantic rejection. */
export class OwnershipValidationError extends Error {}
