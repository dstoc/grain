import type { ActionEnvelope, RangeRef } from '../contracts.js';
import type { IndexedValidation } from '../actions/validation.js';
import { compareBytes } from '../actions/cbor.js';
import { encodeEnvelope } from '../actions/codec.js';
import type { ReadySequence } from '../authoring/ready-source.js';
import type { NativeView } from '../ingest/publication.js';
import type { RetainedPayloadIndex } from '../ingest/validator.js';
import type { OwnershipInput } from './ownership.js';
import type { Activity } from '../visibility/activity.js';
import type { BirthPlacement } from '../layout/index.js';
import { countWork } from '../diagnostics.js';

function encodedAction(action: ActionEnvelope): Uint8Array {
  const bytes = encodeEnvelope(action);
  countWork('authorProof.envelopeBytesEncoded', bytes.length);
  return bytes;
}
interface LocalBase {
  readonly owner: object;
  readonly version: number;
  readonly generation: number;
  readonly ready: ReadySequence;
  readonly payloads: RetainedPayloadIndex;
  assertCurrent(): void;
}
interface Attempt {
  readonly base: LocalBase;
  readonly bytes: Uint8Array;
  readonly past: object;
  readonly dependencies: readonly object[];
  readonly proofs: Set<AuthorProof>;
  native?: { readonly token: object; readonly view: NativeView };
  publication?: { readonly tokens: AuthorPublicationBinding; readonly assertCurrent: () => void };
}
// No wire/context property can confer local authority. Only checkLocal registers
// an indexed invocation, and its finally block removes all borrowed live inputs.
const attempts = new WeakMap<IndexedValidation, Attempt>();
export function openLocalAuthorAttempt(
  indexed: IndexedValidation,
  action: ActionEnvelope,
  base: LocalBase,
): () => void {
  const attempt: Attempt = {
    base,
    bytes: encodedAction(action),
    past: indexed.past.identity,
    dependencies: [...indexed.dependencies],
    proofs: new Set(),
  };
  attempts.set(indexed, attempt);
  return () => {
    if (attempts.get(indexed) === attempt) attempts.delete(indexed);
    for (const proof of attempt.proofs) proofs.delete(proof);
    attempt.proofs.clear();
    attempt.native = undefined;
    attempt.publication = undefined;
  };
}
function assertAttempt(indexed: IndexedValidation, action: ActionEnvelope, attempt: Attempt) {
  attempt.base.assertCurrent();
  if (
    attempts.get(indexed) !== attempt ||
    indexed.past.identity !== attempt.past ||
    indexed.dependencies.length !== attempt.dependencies.length ||
    indexed.dependencies.some((token, i) => token !== attempt.dependencies[i]) ||
    compareBytes(encodedAction(action), attempt.bytes) !== 0
  )
    throw new Error('Author proof attempt was invalidated');
}
/** Called only after native application, native references and allocations pass. */
export function bindAuthorNative(
  indexed: IndexedValidation | undefined,
  action: ActionEnvelope,
  native: NativeView,
): void {
  const attempt = indexed && attempts.get(indexed);
  if (!attempt) return;
  assertAttempt(indexed!, action, attempt);
  attempt.native = { token: Object.freeze({}), view: native };
}
export interface AuthorProofAttempt {
  readonly invocation: object;
  readonly action: ActionEnvelope;
  readonly indexed?: IndexedValidation;
  readonly native: NativeView;
}
export interface LocalAuthorProofRequest extends AuthorProofAttempt {
  /** Invocation-local and memoized by the validator. Host errors must propagate. */
  births(): readonly BirthPlacement[];
}
export interface AuthorProofRequest extends AuthorProofAttempt {
  readonly input: OwnershipInput;
  readonly activity: Activity;
}
export function localAuthorBase(request: AuthorProofAttempt): LocalBase | undefined {
  const attempt = request.indexed && attempts.get(request.indexed);
  if (!attempt) return undefined;
  assertAttempt(request.indexed!, request.action, attempt);
  if (!attempt.native || attempt.native.view !== request.native)
    throw new Error('Author proof native attempt was invalidated');
  return attempt.base;
}
declare const proofBrand: unique symbol;
export interface AuthorProof {
  readonly [proofBrand]: true;
}
export type AuthorProofResult =
  | { readonly state: 'proved'; readonly proof: AuthorProof }
  | { readonly state: 'unavailable'; readonly reason: string }
  | { readonly state: 'rejected' };
export type AuthorProofProvider = (request: AuthorProofRequest) => AuthorProofResult;
export type LocalAuthorProofProvider = (request: LocalAuthorProofRequest) => AuthorProofResult;
/** The committed C/B tuple; detached proofs replace each object with an opaque token. */
export interface AuthorPublicationBinding {
  readonly genesis: object;
  readonly ready: object;
  readonly native: object;
  readonly checkpoint: object;
  readonly projection: object;
  readonly revision: number;
  readonly ownershipRevision: number;
}
function publicationTokens(value: AuthorPublicationBinding): AuthorPublicationBinding {
  return {
    genesis: opaque(value.genesis),
    ready: opaque(value.ready),
    native: opaque(value.native),
    checkpoint: opaque(value.checkpoint),
    projection: opaque(value.projection),
    revision: value.revision,
    ownershipRevision: value.ownershipRevision,
  };
}
function samePublication(a: AuthorPublicationBinding, b: AuthorPublicationBinding) {
  return (
    a.genesis === b.genesis &&
    a.ready === b.ready &&
    a.native === b.native &&
    a.checkpoint === b.checkpoint &&
    a.projection === b.projection &&
    a.revision === b.revision &&
    a.ownershipRevision === b.ownershipRevision
  );
}
export function bindAuthorPublication(
  request: AuthorProofAttempt,
  bindings: AuthorPublicationBinding,
  assertCurrent: () => void,
): void {
  if (!localAuthorBase(request)) throw new Error('Missing local author attempt');
  assertCurrent();
  attempts.get(request.indexed!)!.publication = {
    tokens: publicationTokens(bindings),
    assertCurrent,
  };
}
interface AuthorRefinement {
  readonly before: RangeRef;
  readonly after: readonly RangeRef[];
  readonly reservedBefore: boolean;
  readonly reservedAfter: readonly boolean[];
}
interface DetachedProof {
  readonly invocation: object;
  readonly owner: object;
  readonly version: number;
  readonly generation: number;
  readonly ready: object;
  readonly payloads: object;
  readonly past: object;
  readonly dependencies: readonly object[];
  readonly nativeAttempt: object;
  readonly bytes: Uint8Array;
  readonly bindings: AuthorPublicationBinding;
  readonly ordinals: number;
  readonly refinement: readonly AuthorRefinement[];
}
const proofs = new WeakMap<AuthorProof, DetachedProof>();
const identities = new WeakMap<object, object>();
function opaque(value: object): object {
  let token = identities.get(value);
  if (!token) identities.set(value, (token = Object.freeze({})));
  return token;
}
/** Mint last. The registry owns only detached bytes, counts and opaque tokens;
 * it cannot retain the fork, checkpoint, native facade, document or callbacks. */
export function completeAuthorProof(
  request: AuthorProofAttempt,
  bindings: AuthorPublicationBinding,
  completion: {
    readonly ordinals: number;
    readonly replayFrom: number;
    readonly replayTo: number;
    readonly refinement: readonly AuthorRefinement[];
  },
): AuthorProof {
  const base = localAuthorBase(request);
  if (
    !base ||
    completion.ordinals !== request.action.effects.length ||
    completion.replayFrom !== base.ready.length ||
    completion.replayTo !== base.ready.length + 1
  )
    throw new Error('Cannot complete an unbound or partial author proof');
  const attempt = attempts.get(request.indexed!)!;
  attempt.publication?.assertCurrent();
  if (
    !attempt.publication ||
    !samePublication(publicationTokens(bindings), attempt.publication.tokens)
  )
    throw new Error('Missing exact author publication binding');
  const refinement = structuredClone(completion.refinement);
  countWork('authorProof.refinementWitnessesCopied', refinement.length);
  countWork(
    'authorProof.refinementRangesCopied',
    refinement.reduce((sum, entry) => sum + 1 + entry.after.length, 0),
  );
  countWork('authorProof.actionBytesCopied', attempt.bytes.length);
  const proof = Object.freeze({}) as AuthorProof;
  proofs.set(proof, {
    invocation: request.invocation,
    owner: opaque(base.owner),
    version: base.version,
    generation: base.generation,
    ready: opaque(base.ready),
    payloads: opaque(base.payloads),
    past: attempt.past,
    dependencies: [...attempt.dependencies],
    nativeAttempt: attempt.native!.token,
    bytes: attempt.bytes.slice(),
    bindings: publicationTokens(bindings),
    ordinals: completion.ordinals,
    refinement,
  });
  attempt.proofs.add(proof);
  return proof;
}
export function consumeAuthorProof(request: AuthorProofAttempt, proof: AuthorProof): void {
  const completed = proofs.get(proof);
  proofs.delete(proof);
  const base = localAuthorBase(request);
  const attempt = request.indexed && attempts.get(request.indexed);
  attempt?.publication?.assertCurrent();
  if (
    !completed ||
    !base ||
    !attempt ||
    completed.invocation !== request.invocation ||
    completed.owner !== opaque(base.owner) ||
    completed.version !== base.version ||
    completed.generation !== base.generation ||
    completed.ready !== opaque(base.ready) ||
    completed.payloads !== opaque(base.payloads) ||
    completed.past !== attempt.past ||
    completed.nativeAttempt !== attempt.native!.token ||
    !attempt.publication ||
    !samePublication(completed.bindings, attempt.publication.tokens) ||
    completed.dependencies.length !== attempt.dependencies.length ||
    completed.dependencies.some((token, i) => token !== attempt.dependencies[i]) ||
    completed.ordinals !== request.action.effects.length ||
    compareBytes(completed.bytes, encodedAction(request.action)) !== 0
  )
    throw new Error('Invalid or expired author proof');
  countWork('authorProof.hits');
}
export function discardAuthorProof(proof: AuthorProof): void {
  proofs.delete(proof);
}

/** Expected conservative miss, caught only by strict author preparation. */
export class AuthorProofUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export class AuthorProofProviderError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Author proof provider failed', { cause });
  }
}
