import { countWork, measure, measureWork } from '../diagnostics.js';
import { encodeEnvelope } from '../actions/codec.js';
import type { ActionEnvelope } from '../contracts.js';
import { readyAppend } from './ready-index.js';
import { finish } from '../ingest/work.js';
import type { PreparedLocalPublication } from '../authoring/document.js';
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
// Expired handles retain their immutable result, never a live document or cache.
const localHandles = new WeakMap<
  object,
  { assertCurrent(action: ActionEnvelope): void; cancel(): void }
>();
function localHandle<T>(
  publication: PublishedProjection<T>,
  token: object,
): PreparedLocalPublication<T> {
  return Object.freeze({
    publication,
    assertCurrent: (action: ActionEnvelope) => {
      const live = localHandles.get(token);
      if (!live) throw new Error('Local candidate is no longer current');
      live.assertCurrent(action);
    },
    cancel: () => localHandles.get(token)?.cancel(),
  });
}
interface LocalCandidate<T> {
  readonly token: object;
  readonly base: PublishedProjection<T>;
  readonly source: ReadySource;
  readonly version: number;
  readonly generation: number;
  readonly action: ActionEnvelope;
  readonly bytes: Uint8Array;
  readonly publication: PublishedProjection<T>;
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
  private local?: LocalCandidate<T>;
  private preparingLocal?: object;
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
      staging?: boolean,
    ) => Work<T>,
    private decodeOperations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
    private readonly retainReady: (
      actions: ReadySequence,
      variants: Pick<ReadonlyMap<string, Uint8Array>, 'get'>,
    ) => void = () => {},
    private readonly reduction: {
      readonly fullProjectionCount?: () => number;
      readonly commit?: (accepted?: ReadySequence) => void;
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
  /** Prepare once on private native/semantic roots. Only build() can publish them.
   * Cancellation drops the advanced native cache; old native roots stay readable.
   */
  prepareLocal(
    action: ActionEnvelope,
    certify: (action: ActionEnvelope) => void,
  ): PreparedLocalPublication<T> | undefined {
    if (this.local) {
      this.cancel();
      countWork('command.candidateFallback.competing-preparation');
      return undefined;
    }
    const status = this.status();
    const base = status.publication,
      source = this.snapshot && readySource(readySequence(this.snapshot));
    if (
      !base ||
      status.stale ||
      !source ||
      !this.native ||
      !this.snapshot ||
      this.refreshing ||
      this.preparingLocal
    )
      return undefined;
    const observed = new Set(action.dependencies.map(actionKey));
    if (
      !base.heads.every((head) => observed.has(actionKey(head))) ||
      source.has(actionKey(action.id)) ||
      action.lamport <= source.maxLamport
    ) {
      countWork('command.candidateFallback.not-exact-published-base');
      return undefined;
    }
    if (this.nativeSource !== source) {
      countWork('command.candidateFallback.incomplete-native-base');
      return undefined;
    }
    const version = this.store.factsVersion,
      baseGeneration = this.generation;
    const bytes = encodeEnvelope(action);
    countWork('command.candidateBytesEncoded', bytes.length);
    // Own the payload. Compiler buffers and caller objects cannot alter this candidate.
    const owned = structuredClone(action);
    countWork('command.candidatePayloadsCloned');
    certify(owned);
    if (
      version !== this.store.factsVersion ||
      this.generation !== baseGeneration ||
      this.published !== base ||
      compareBytes(encodeEnvelope(owned), bytes) !== 0
    )
      throw new Error('Local certification invalidated the candidate');
    this.cancel();
    const generation = this.generation;
    const preparing = Object.freeze({});
    this.preparingLocal = preparing;
    try {
      measure(
        'native-preparation',
        () => finish(this.apply(actionKey(owned.id), owned)),
        'publication',
      );
      const native = Object.freeze(this.native!.view());
      const sequence = readyAppend(readySequence(this.snapshot), owned);
      const key = actionKey(owned.id);
      const variants = {
        get: (id: string) => (id === key ? bytes : this.snapshot!.variants.get(id)),
      };
      const fullBefore = this.reduction.fullProjectionCount?.();
      const value = measure(
        'visibility-normalization',
        () => finish(this.reduce(sequence, native, variants, true)),
        'publication',
      );
      this.counts.fullProjections +=
        fullBefore === undefined ? 1 : this.reduction.fullProjectionCount!() - fullBefore;
      if (
        version !== this.store.factsVersion ||
        generation !== this.generation ||
        this.published !== base
      )
        throw new Error('Local candidate invalidated during preparation');
      const publication = Object.freeze({
        heads: Object.freeze([Object.freeze(owned.id)]),
        native,
        value,
      });
      const token = Object.freeze({});
      const candidate: LocalCandidate<T> = Object.freeze({
        token,
        base,
        source,
        version,
        generation,
        action: owned,
        bytes,
        publication,
      });
      this.local = candidate;
      countWork('command.candidatesPrepared');
      localHandles.set(token, {
        assertCurrent: (final: ActionEnvelope) => {
          if (
            this.local !== candidate ||
            this.published !== base ||
            this.generation !== generation ||
            this.store.factsVersion !== version ||
            compareBytes(encodeEnvelope(final), bytes) !== 0
          )
            throw new Error('Local candidate is no longer current');
        },
        cancel: () => {
          if (this.local === candidate) this.cancel();
        },
      });
      return localHandle(publication, token);
    } catch (error) {
      this.reduction.cancel?.();
      this.dropNative();
      throw error;
    } finally {
      if (this.preparingLocal === preparing) this.preparingLocal = undefined;
    }
  }
  refresh(operations?: number): Computation<PublishedProjection<T>> {
    this.assertOpen();
    if (operations !== undefined) assertLimit(operations);
    // A prepared local candidate owns the current reduction generation until
    // exact ready admission either consumes it or selects the ordinary fallback.
    if (!this.local || this.active) this.cancel();
    const version = this.store.factsVersion,
      generation = this.generation;
    if (this.published && version === this.publishedVersion) {
      this.counts.unchangedRefreshes++;
      return { state: 'complete', value: this.published };
    }
    this.active = measureWork('publication', this.build(version, generation), 'publication');
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
      const candidate = this.local;
      if (candidate) {
        const source = readySource(readySequence(snapshot));
        const delta = source?.additions(candidate.source);
        this.counts.readyIndexNodesVisited += delta?.nodesVisited ?? 0;
        const key = actionKey(candidate.action.id);
        const payload = variants.get(key);
        if (
          candidate.base === this.published &&
          candidate.generation === generation &&
          delta?.actions.length === 1 &&
          actionKey(delta.actions[0].id) === key &&
          payload &&
          compareBytes(payload, candidate.bytes) === 0 &&
          readySequence(snapshot).length === readySequence(this.snapshot!).length + 1
        ) {
          if (this.closed || version !== this.store.factsVersion || generation !== this.generation)
            throw new Error('Local publication invalidated by changed facts');
          this.reduction.commit?.(readySequence(snapshot));
          this.integrated.set(key, candidate.bytes);
          this.counts.nativeReadyActionsVisited++;
          this.nativeSource = source;
          this.snapshot = snapshot;
          this.published = candidate.publication;
          this.publishedVersion = version;
          this.releaseLocal();
          committed = true;
          countWork('command.candidatesPublished');
          countWork('publication.committed');
          return candidate.publication;
        }
        countWork('command.candidateFallback.changed-ready');
        this.releaseLocal();
        this.reduction.cancel?.();
        this.dropNative();
      }
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
      this.reduction.commit?.(readySequence(snapshot));
      this.snapshot = snapshot;
      this.published = publication;
      this.publishedVersion = version;
      committed = true;
      countWork('publication.committed');
      return publication;
    } finally {
      if (!committed) {
        if (this.local) {
          this.releaseLocal();
          this.dropNative();
        }
        this.reduction.cancel?.();
      }
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
      yield* measureWork('native-preparation', native.apply(key, body));
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
  private releaseLocal(): void {
    if (this.local) localHandles.delete(this.local.token);
    this.local = undefined;
  }
  private cancel(): void {
    if (this.preparingLocal) {
      this.preparingLocal = undefined;
      this.dropNative();
      countWork('command.preparationCancelled');
    }
    if (this.local) {
      this.releaseLocal();
      this.dropNative();
      countWork('command.candidatesCancelled');
    }
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
