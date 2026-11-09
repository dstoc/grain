import { OwnershipValidationError } from '../ownership/errors.js';
import type { FlowId } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { PersistentMap } from './map.js';

/** A certificate for one exact coupled prefix. Only top-level flows emit cells.
 * Fork before invalidation or subdivision; old publications keep their own roots.
 */
export class OwnershipCoverage {
  private flows = new PersistentMap<PersistentMap<true>>();
  private cells = new PersistentMap<string>();
  private dirty = new Map<string, FlowId>();
  fork(): OwnershipCoverage {
    const copy = new OwnershipCoverage();
    copy.flows = this.flows.fork();
    copy.cells = this.cells.fork();
    copy.dirty = new Map(this.dirty);
    return copy;
  }
  invalidate(flow: FlowId): void {
    this.dirty.set(resourceKey(flow), flow);
  }
  /** Subdivision preserves every checkpoint's own assignment/component. It does
   * not import membership from the latest replay or retain a native read facade.
   */
  refine(replacements: ReadonlyMap<string, readonly string[]>): void {
    const changed = new Map<string, PersistentMap<true>>();
    for (const [before, after] of replacements) {
      const flow = this.cells.get(before);
      if (flow === undefined)
        throw new OwnershipValidationError('Refined cell lacks a coverage certificate');
      let keys = changed.get(flow);
      if (!keys) changed.set(flow, (keys = this.flows.get(flow)!.fork()));
      keys.delete(before);
      this.cells.delete(before);
      for (const key of after) {
        if (this.cells.has(key)) throw new OwnershipValidationError('Cell emitted more than once');
        keys.set(key, true);
        this.cells.set(key, flow);
      }
    }
    for (const [flow, keys] of changed) this.flows.set(flow, keys);
  }
  check(
    ownerCount: number,
    read: (flow: FlowId) => Iterable<string> | undefined,
    visit: () => void,
  ): void {
    // Remove all prior memberships before checking any changed root: a join,
    // split or transfer can move a cell between two invalidated components.
    for (const key of this.dirty.keys()) {
      for (const cell of this.flows.get(key)?.keys() ?? []) this.cells.delete(cell);
      this.flows.delete(key);
    }
    for (const [key, flow] of this.dirty) {
      const entries = read(flow);
      if (!entries) continue; // This previously standalone flow is now attached.
      visit();
      const keys = new PersistentMap<true>();
      for (const cell of entries) {
        if (this.cells.has(cell)) throw new OwnershipValidationError('Cell emitted more than once');
        keys.set(cell, true);
        this.cells.set(cell, key);
      }
      this.flows.set(key, keys);
    }
    if (this.cells.size !== ownerCount)
      throw new OwnershipValidationError('Owned cell is unreachable in raw traversal');
    this.dirty.clear();
  }
}
