import type { ActionId, Allocation, GroupId, ResourceId, ResourceKind } from '../contracts.js';

/** Internal certificate-backed author past. Queries return detached resources.
 * Identity tokens represent exact immutable payload/dependency facts, never just IDs.
 * The public dependency array remains available lazily for compatibility validators.
 */
export interface CertifiedPast {
  readonly identity: object;
  contains(id: ActionId): boolean;
  allocation(id: ResourceId<ResourceKind>): Allocation | undefined;
  groupSealed(group: GroupId): boolean;
}
export interface IndexedValidation {
  readonly past: CertifiedPast;
  readonly resultIdentity: object;
  readonly dependencies: readonly object[];
}
