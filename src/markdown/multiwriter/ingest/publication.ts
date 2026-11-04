import type { ActionEnvelope, ActionId } from '../contracts.js';
import { ActionStore } from '../actions/store.js';
import type { ActionStoreSnapshot } from '../actions/store.js';
import { compareBytes } from '../actions/cbor.js';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeBody } from '../text/types.js';
import { DEFAULT_INGEST_LIMITS, IngestDataError, compute } from './work.js';
import type { Computation, Work } from './work.js';

export type NativeView = Pick<
  NativeTapeCache,
  'snapshot' | 'range' | 'lookup' | 'marker' | 'locate' | 'encodeState'
>;
/** Read-only facade: no native writer, Yjs doc, provider or destroy method escapes. */
export function nativeView(cache: NativeTapeCache): NativeView {
  return {
    snapshot: cache.snapshot.bind(cache),
    range: cache.range.bind(cache),
    lookup: cache.lookup.bind(cache),
    marker: cache.marker.bind(cache),
    locate: cache.locate.bind(cache),
    encodeState: cache.encodeState.bind(cache),
  };
}
export interface PublishedProjection<T> {
  readonly heads: readonly ActionId[];
  /** Reducer state, projection and edit addresses must be returned together in this value. */
  readonly value: T;
  readonly native: NativeView;
}
export interface ProjectionStatus<T> {
  readonly publication?: PublishedProjection<T>;
  readonly stale: boolean;
  readonly canAuthor: boolean;
}

/**
 * Headless reference publication boundary. MW-08 supplies the REAL reducer and addresses;
 * this class does not implement ownership/projection. MW-13 owns incremental replay.
 */
export class IngestPublication<T> {
  private published?: { snapshot: ActionStoreSnapshot; native: NativeTapeCache; value: T };
  private generation = 0;
  private candidate?: NativeTapeCache;
  private closed = false;
  private publishedVersion = -1;
  private refreshing = false;
  private active?: Work<PublishedProjection<T>>;
  constructor(
    private readonly store: ActionStore,
    private readonly genesis: NativeBody,
    private readonly reduce: (actions: readonly ActionEnvelope[], native: NativeView) => Work<T>,
    private readonly decodeOperations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
  ) {}

  /** Rechecks readiness before granting authoring. Missing independent branches do not block it. */
  status(): ProjectionStatus<T> {
    this.assertOpen();
    const published = this.published;
    const version = this.store.factsVersion;
    const current =
      version === this.publishedVersion
        ? published?.snapshot
        : this.refreshing
          ? undefined
          : this.store.snapshot();
    if (!published) return { stale: true, canAuthor: false };
    if (!current)
      return {
        publication: {
          heads: structuredClone(published.snapshot.heads),
          value: published.value,
          native: nativeView(published.native),
        },
        stale: true,
        canAuthor: false,
      };
    const included = (action: ActionEnvelope) => {
      const old = published.snapshot.actions.find(
        (entry) => entry.id.actor === action.id.actor && entry.id.sequence === action.id.sequence,
      )!;
      return current.actions.some(
        (entry) =>
          entry.id.actor === action.id.actor &&
          entry.id.sequence === action.id.sequence &&
          entry.readiness.state === 'ready' &&
          compareBytes(entry.variants[0], old.variants[0]) === 0,
      );
    };
    const canAuthor = current.integrity && published.snapshot.ready.every(included);
    const stale = !canAuthor || current.ready.length !== published.snapshot.ready.length;
    return {
      publication: {
        heads: structuredClone(published.snapshot.heads),
        value: published.value,
        native: nativeView(published.native),
      },
      stale,
      canAuthor: canAuthor && !stale,
    };
  }

  refresh(operations?: number): Computation<PublishedProjection<T>> {
    this.assertOpen();
    const generation = ++this.generation;
    this.active?.return(undefined as unknown as PublishedProjection<T>);
    this.candidate?.destroy();
    this.candidate = undefined;
    const version = this.store.factsVersion;
    this.active = this.rebuild(version, generation);
    return compute(
      this.active,
      operations,
      () => !this.closed && generation === this.generation && version === this.store.factsVersion,
    );
  }

  private *rebuild(version: number, generation: number): Work<PublishedProjection<T>> {
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
      const candidate = new NativeTapeCache(this.decodeOperations);
      this.candidate = candidate;
      let committed = false;
      try {
        yield* candidate.applySteps('genesis', this.genesis);
        for (let index = 0; index < snapshot.ready.length; index++) {
          yield;
          yield* candidate.applySteps(`action:${index}`, snapshot.ready[index]);
        }
        const value = yield* this.reduce(structuredClone(snapshot.ready), nativeView(candidate));
        if (this.closed || version !== this.store.factsVersion || generation !== this.generation)
          throw new Error('Ingest publication invalidated by changed facts');
        const previous = this.published;
        this.published = { snapshot, native: candidate, value };
        this.candidate = undefined;
        this.publishedVersion = version;
        committed = true;
        previous?.native.destroy();
        return { heads: structuredClone(snapshot.heads), native: nativeView(candidate), value };
      } finally {
        if (!committed) candidate.destroy();
      }
    } finally {
      if (state.state === 'deferred') state.continuation.cancel();
      this.refreshing = false;
    }
  }

  destroy(): void {
    this.closed = true;
    this.generation++;
    this.active?.return(undefined as unknown as PublishedProjection<T>);
    this.candidate?.destroy();
    this.published?.native.destroy();
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Ingest publication closed');
  }
}
