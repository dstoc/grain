import type { ActionEnvelope } from '../contracts.js';
import type { ActionStore, ActionStoreSnapshot } from '../actions/store.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';
import type { NativeView, ProjectionStatus, PublishedProjection } from '../ingest/publication.js';
import { DEFAULT_INGEST_LIMITS, IngestDataError, assertLimit, compute } from '../ingest/work.js';
import type { Computation, Work } from '../ingest/work.js';
import type { NativeBody } from '../text/types.js';
import { MaterializedNative } from './native.js';

export interface MaterializationWork {
  nativeBodiesIntegrated: number;
  tapesIndexed: number;
  partsIndexed: number;
  nativeRebuilds: number;
  fullProjections: number;
  unchangedRefreshes: number;
  discardedNativeCandidates: number;
}
/** Incremental native stage. Readiness and semantic reduction still use the full oracle.
 * These fallbacks are explicit in diagnostics; this is not the completed MW-13 fast path.
 */
export class MaterializedPublication<T> {
  private published?: PublishedProjection<T>;
  private snapshot?: ActionStoreSnapshot;
  private publishedVersion = -1;
  private generation = 0;
  private active?: Work<PublishedProjection<T>>;
  private native?: MaterializedNative;
  private integrated = new Map<string, Uint8Array>();
  private closed = false;
  private refreshing = false;
  private readonly counts: MaterializationWork = {
    nativeBodiesIntegrated: 0,
    tapesIndexed: 0,
    partsIndexed: 0,
    nativeRebuilds: 0,
    fullProjections: 0,
    unchangedRefreshes: 0,
    discardedNativeCandidates: 0,
  };
  constructor(
    private readonly store: ActionStore,
    private readonly genesis: NativeBody,
    private readonly reduce: (actions: readonly ActionEnvelope[], native: NativeView) => Work<T>,
    private decodeOperations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
    private readonly retainReady: (actions: readonly ActionEnvelope[]) => void = () => {},
  ) {}
  diagnostics(): Readonly<MaterializationWork> {
    return { ...this.counts };
  }
  status(): ProjectionStatus<T> {
    this.assertOpen();
    // Pending independent branches and duplicate receipts need not suspend authoring.
    // Do not replace an in-flight store calculation from a status read.
    if (this.published && this.publishedVersion !== this.store.factsVersion && !this.refreshing) {
      const snapshot = this.store.snapshot();
      if (this.sameReady(snapshot)) {
        this.retainReady(snapshot.ready);
        this.snapshot = snapshot;
        this.publishedVersion = this.store.factsVersion;
      }
    }
    const stale = !this.published || this.publishedVersion !== this.store.factsVersion;
    return { publication: this.published, stale, canAuthor: !stale };
  }
  /** Release disposable integration state. The active immutable publication stays readable.
   * Canonical facts and the provider journal are neither written nor consolidated here.
   */
  evict(): void {
    this.assertOpen();
    this.cancel();
    this.dropNative();
  }
  setDecodeLimit(operations: number): void {
    this.assertOpen();
    assertLimit(operations);
    this.cancel();
    this.dropNative();
    this.decodeOperations = operations;
  }
  refresh(operations?: number): Computation<PublishedProjection<T>> {
    this.assertOpen();
    if (operations !== undefined) assertLimit(operations);
    this.cancel();
    const version = this.store.factsVersion,
      generation = this.generation;
    if (this.published && version === this.publishedVersion) {
      this.counts.unchangedRefreshes++;
      return { state: 'complete', value: this.published };
    }
    this.active = this.build(version, generation);
    return compute(
      this.active,
      operations,
      () => !this.closed && this.generation === generation && this.store.factsVersion === version,
    );
  }
  private *build(version: number, generation: number): Work<PublishedProjection<T>> {
    this.refreshing = true;
    let state = this.store.compute(0);
    try {
      while (state.state === 'deferred') {
        yield;
        state = state.continuation.resume(1);
      }
      const snapshot = state.value;
      if (!snapshot.integrity)
        throw new IngestDataError('carrier', 'integrity', 'Canonical store integrity failed');
      this.retainReady(snapshot.ready);
      const variants = new Map(
        snapshot.actions
          .filter((a) => a.readiness.state === 'ready')
          .map((a) => [actionKey(a.id), a.variants[0]]),
      );
      if (this.sameReady(snapshot) && this.published) {
        this.snapshot = snapshot;
        this.publishedVersion = version;
        this.counts.unchangedRefreshes++;
        return this.published;
      }
      if (
        [...this.integrated].some(([key, bytes]) => {
          const next = variants.get(key);
          return !next || compareBytes(next, bytes) !== 0;
        })
      ) {
        this.dropNative();
        this.counts.nativeRebuilds++;
      }
      if (!this.native) {
        this.native = new MaterializedNative(this.decodeOperations);
        yield* this.apply('genesis', this.genesis);
      }
      for (const action of snapshot.ready) {
        yield;
        const key = actionKey(action.id);
        if (this.integrated.has(key)) continue;
        yield* this.apply(key, action);
        this.integrated.set(key, variants.get(key)!);
      }
      const native = Object.freeze(this.native.view());
      this.counts.fullProjections++;
      const value = yield* this.reduce(structuredClone(snapshot.ready), native);
      if (this.closed || version !== this.store.factsVersion || generation !== this.generation)
        throw new Error('Ingest publication invalidated by changed facts');
      const heads = Object.freeze(snapshot.heads.map((id) => Object.freeze(structuredClone(id))));
      const publication = Object.freeze({ heads, native, value });
      this.snapshot = snapshot;
      this.published = publication;
      this.publishedVersion = version;
      return publication;
    } finally {
      if (state.state === 'deferred') state.continuation.cancel();
      this.refreshing = false;
    }
  }
  private sameReady(snapshot: ActionStoreSnapshot): boolean {
    if (
      !snapshot.integrity ||
      !this.snapshot ||
      this.snapshot.ready.length !== snapshot.ready.length
    )
      return false;
    const variants = new Map(
      snapshot.actions
        .filter((a) => a.readiness.state === 'ready')
        .map((a) => [actionKey(a.id), a.variants[0]]),
    );
    return this.snapshot.actions
      .filter((a) => a.readiness.state === 'ready')
      .every((a) => {
        const bytes = variants.get(actionKey(a.id));
        return bytes !== undefined && compareBytes(a.variants[0], bytes) === 0;
      });
  }
  private *apply(key: string, body: NativeBody): Work<void> {
    const native = this.native!;
    const before = { ...native.work };
    let complete = false;
    try {
      yield* native.apply(key, body);
      complete = true;
    } finally {
      this.counts.nativeBodiesIntegrated += native.work.bodiesIntegrated - before.bodiesIntegrated;
      this.counts.tapesIndexed += native.work.tapesIndexed - before.tapesIndexed;
      this.counts.partsIndexed += native.work.partsIndexed - before.partsIndexed;
      if (!complete) {
        this.counts.discardedNativeCandidates++;
        this.dropNative();
      }
    }
  }
  private cancel(): void {
    this.generation++;
    this.active?.return(undefined as unknown as PublishedProjection<T>);
    this.active = undefined;
  }
  private dropNative(): void {
    this.native?.destroy();
    this.native = undefined;
    this.integrated.clear();
  }
  destroy(): void {
    this.cancel();
    this.dropNative();
    this.published = undefined;
    this.snapshot = undefined;
    this.closed = true;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Materialized publication closed');
  }
}
