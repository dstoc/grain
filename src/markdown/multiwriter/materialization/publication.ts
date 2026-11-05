import type { ActionStore } from '../actions/store.js';
import { IndexedActionStore, readySequence } from './readiness.js';
import type { ReadySequence } from '../authoring/ready-source.js';
import type { ReadyActionView } from './readiness.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';
import type { NativeView, ProjectionStatus, PublishedProjection } from '../ingest/publication.js';
import { DEFAULT_INGEST_LIMITS, IngestDataError, assertLimit, compute } from '../ingest/work.js';
import type { Computation, Work } from '../ingest/work.js';
import type { NativeBody } from '../text/types.js';
import { MaterializedNative } from './native.js';
import { readySource } from '../authoring/ready-source.js';
import type { ReadySource } from '../authoring/ready-source.js';

export interface MaterializationWork {
  nativeBodiesIntegrated: number;
  tapesIndexed: number;
  partsIndexed: number;
  nativeRebuilds: number;
  fullProjections: number;
  unchangedRefreshes: number;
  discardedNativeCandidates: number;
  nativeMembershipScanned: number;
  nativeReadyActionsVisited: number;
  readyIndexNodesVisited: number;
}
/** Incremental native stage. Readiness and semantic reduction still use the full oracle.
 * These fallbacks are explicit in diagnostics; this is not the completed MW-13 fast path.
 */
export class MaterializedPublication<T> {
  private published?: PublishedProjection<T>;
  private snapshot?: ReadyActionView;
  private publishedVersion = -1;
  private generation = 0;
  private active?: Work<PublishedProjection<T>>;
  private native?: MaterializedNative;
  private integrated = new Map<string, Uint8Array>();
  private nativeSource?: ReadySource;
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
    nativeMembershipScanned: 0,
    nativeReadyActionsVisited: 0,
    readyIndexNodesVisited: 0,
  };
  constructor(
    private readonly store: ActionStore,
    private readonly genesis: NativeBody,
    private readonly reduce: (
      actions: ReadySequence,
      native: NativeView,
      variants: Pick<ReadonlyMap<string, Uint8Array>, 'get'>,
    ) => Work<T>,
    private decodeOperations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
    private readonly retainReady: (
      actions: ReadySequence,
      variants: Pick<ReadonlyMap<string, Uint8Array>, 'get'>,
    ) => void = () => {},
    private readonly reduction: {
      readonly fullProjectionCount?: () => number;
      readonly commit?: () => void;
      readonly cancel?: () => void;
      readonly evict?: () => void;
    } = {},
  ) {}
  diagnostics(): Readonly<MaterializationWork> {
    return { ...this.counts };
  }
  status(): ProjectionStatus<T> {
    this.assertOpen();
    // Pending independent branches and duplicate receipts need not suspend authoring.
    // Do not replace an in-flight store calculation from a status read.
    if (this.published && this.publishedVersion !== this.store.factsVersion && !this.refreshing) {
      const snapshot = this.readReady();
      if (this.sameReady(snapshot)) {
        this.retainReady(readySequence(snapshot), snapshot.variants);
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
    this.reduction.evict?.();
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
    let state = this.computeReady(0);
    let committed = false;
    try {
      while (state.state === 'deferred') {
        yield;
        state = state.continuation.resume(1);
      }
      const snapshot = state.value;
      if (!snapshot.integrity)
        throw new IngestDataError('carrier', 'integrity', 'Canonical store integrity failed');
      this.retainReady(readySequence(snapshot), snapshot.variants);
      const variants = snapshot.variants;
      if (this.sameReady(snapshot) && this.published) {
        this.snapshot = snapshot;
        this.publishedVersion = version;
        this.counts.unchangedRefreshes++;
        return this.published;
      }
      const source = readySource(readySequence(snapshot));
      const delta = source && this.nativeSource ? source.additions(this.nativeSource) : undefined;
      if (delta) this.counts.readyIndexNodesVisited += delta.nodesVisited;
      // Native integration can advance before a suspended publication is cancelled.
      // Only a completely integrated set gets an index token. Partial integration
      // must use the full membership check on its next attempt.
      this.nativeSource = undefined;
      if (
        !delta &&
        [...this.integrated].some(([key, bytes]) => {
          this.counts.nativeMembershipScanned++;
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
      for (const action of delta?.actions ?? readySequence(snapshot)) {
        yield;
        this.counts.nativeReadyActionsVisited++;
        const key = actionKey(action.id);
        if (this.integrated.has(key)) continue;
        yield* this.apply(key, action);
        this.integrated.set(key, variants.get(key)!);
      }
      this.nativeSource = source;
      const native = Object.freeze(this.native.view());
      const fullBefore = this.reduction.fullProjectionCount?.();
      const value = yield* this.reduce(readySequence(snapshot), native, variants);
      this.counts.fullProjections +=
        fullBefore === undefined ? 1 : this.reduction.fullProjectionCount!() - fullBefore;
      if (this.closed || version !== this.store.factsVersion || generation !== this.generation)
        throw new Error('Ingest publication invalidated by changed facts');
      const heads = Object.freeze(snapshot.heads.map((id) => Object.freeze(structuredClone(id))));
      const publication = Object.freeze({ heads, native, value });
      this.reduction.commit?.();
      this.snapshot = snapshot;
      this.published = publication;
      this.publishedVersion = version;
      committed = true;
      return publication;
    } finally {
      if (!committed) this.reduction.cancel?.();
      if (state.state === 'deferred') state.continuation.cancel();
      this.refreshing = false;
    }
  }
  private readReady(): ReadyActionView {
    if (this.store instanceof IndexedActionStore) return this.store.readReady();
    return this.referenceView(this.store.snapshot());
  }
  private computeReady(operations: number): Computation<ReadyActionView> {
    if (this.store instanceof IndexedActionStore) return this.store.computeReady(operations);
    const map = (state: ReturnType<ActionStore['compute']>): Computation<ReadyActionView> =>
      state.state === 'complete'
        ? { state: 'complete', value: this.referenceView(state.value) }
        : {
            state: 'deferred',
            continuation: {
              cancel: () => state.continuation.cancel(),
              resume: (budget) => map(state.continuation.resume(budget)),
            },
          };
    return map(this.store.compute(operations));
  }
  private referenceView(snapshot: ReturnType<ActionStore['snapshot']>): ReadyActionView {
    return {
      ready: snapshot.ready,
      heads: snapshot.heads,
      integrity: snapshot.integrity,
      variants: new Map(
        snapshot.actions
          .filter((a) => a.readiness.state === 'ready')
          .map((a) => [actionKey(a.id), a.variants[0]]),
      ),
    };
  }
  private sameReady(snapshot: ReadyActionView): boolean {
    if (
      !snapshot.integrity ||
      !this.snapshot ||
      readySequence(this.snapshot).length !== readySequence(snapshot).length
    )
      return false;
    const source = readySource(readySequence(snapshot)),
      before = readySource(readySequence(this.snapshot));
    if (source && before) {
      const delta = source.additions(before);
      if (delta) {
        this.counts.readyIndexNodesVisited += delta.nodesVisited;
        return delta.actions.length === 0;
      }
    }
    return [...readySequence(this.snapshot)].every((action) => {
      const key = actionKey(action.id),
        bytes = this.snapshot!.variants.get(key);
      const next = snapshot.variants.get(key);
      return (
        bytes !== undefined &&
        next !== undefined &&
        (next === bytes || compareBytes(next, bytes) === 0)
      );
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
    this.reduction.cancel?.();
  }
  private dropNative(): void {
    this.native?.destroy();
    this.native = undefined;
    this.integrated.clear();
    this.nativeSource = undefined;
  }
  destroy(): void {
    this.cancel();
    this.dropNative();
    this.reduction.evict?.();
    this.published = undefined;
    this.snapshot = undefined;
    this.closed = true;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Materialized publication closed');
  }
}
