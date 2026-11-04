import { ActionStore } from '../actions/store.js';
import type { ActionStoreSnapshot } from '../actions/store.js';
import { assertLimit } from '../ingest/work.js';

/** Reference readers often inspect the same closure many times per schedule step.
 * Cache only complete results for the exact facts version; misses use MW-01 unchanged.
 * This is not an incremental reducer or a production authoring fast path.
 */
export class ReferenceActionStore extends ActionStore {
  private memo?: { version: number; snapshot: ActionStoreSnapshot };
  override snapshot(): ActionStoreSnapshot {
    if (this.memo?.version === this.factsVersion) return structuredClone(this.memo.snapshot);
    const snapshot = super.snapshot();
    this.memo = { version: this.factsVersion, snapshot: structuredClone(snapshot) };
    return snapshot;
  }
  override compute(operations?: number) {
    if (operations !== undefined) assertLimit(operations);
    if (this.memo?.version === this.factsVersion)
      return { state: 'complete' as const, value: structuredClone(this.memo.snapshot) };
    const result = super.compute(operations);
    if (result.state === 'complete')
      this.memo = { version: this.factsVersion, snapshot: structuredClone(result.value) };
    return result;
  }
  override setDecodeLimits(limits: { depth?: number; operations?: number }): void {
    this.memo = undefined;
    super.setDecodeLimits(limits);
  }
  override destroy(): void {
    this.memo = undefined;
    super.destroy();
  }
}
