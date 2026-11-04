import * as Y from 'yjs';
import { compareActions, PROTOCOL_VERSION } from '../contracts.js';
import type { ActionEnvelope, ActionId, ActionReadiness, Allocation } from '../contracts.js';
import { compareBytes } from './cbor.js';
import { decodeEnvelope, encodeEnvelope, EnvelopeDecodeError } from './codec.js';
import { actionKey, validReferences } from './references.js';

type QuarantineReason = Extract<ActionReadiness, { state: 'quarantined' }>['reason'];
export interface ActionValidationContext {
  /** Full ready dependency closure, in semantic order. Never the later merged projection. */
  readonly dependencies: readonly ActionEnvelope[];
}
export interface ActionStoreOptions {
  readonly documentId: string;
  readonly genesisId: string;
  readonly genesisAllocations: readonly Allocation[];
  /**
   * Required certification of native bodies/manifests and author-local semantic validity.
   * Must be synchronous, deterministic and side-effect free. MW-02/MW-15 supply the validator.
   * No action is ready before it returns null. Exceptions fail closed and propagate to the caller.
   */
  readonly validate: (
    action: ActionEnvelope,
    context: ActionValidationContext,
  ) => QuarantineReason | null;
}
export interface StoredAction {
  readonly id: ActionId;
  /** Copies, sorted bytewise. Conflicts are retained, never selected by arrival order. */
  readonly variants: readonly Uint8Array[];
  readonly readiness: ActionReadiness;
}
export interface ActionStoreSnapshot {
  readonly actions: readonly StoredAction[];
  readonly ready: readonly ActionEnvelope[];
  readonly heads: readonly ActionId[];
  /** Records without a decodable action ID, plus append-only collection violations. */
  readonly diagnostics: readonly string[];
  readonly integrity: boolean;
}
interface Variant {
  readonly bytes: Uint8Array;
  readonly envelope?: ActionEnvelope;
  readonly reason?: QuarantineReason;
}
interface Entry {
  readonly id: ActionId;
  readonly variants: Variant[];
}
const quarantined = (reason: QuarantineReason): ActionReadiness => ({
  state: 'quarantined',
  reason,
});
const compareIds = (a: ActionId, b: ActionId): number =>
  a.actor < b.actor
    ? -1
    : a.actor > b.actor
      ? 1
      : a.sequence < b.sequence
        ? -1
        : a.sequence > b.sequence
          ? 1
          : 0;

/**
 * Canonical append-only envelope collection. The private Y.Doc prevents callers from mutating
 * stored byte arrays or deleting entries through the local API. Only this document is exchanged.
 * A snapshot is a full reference readiness calculation, not an accepted revision or a reducer.
 */
export class ActionStore {
  private readonly doc = new Y.Doc({ gc: false });
  private readonly envelopes = this.doc.getArray<Uint8Array>('envelopes');
  private readonly entries = new Map<string, Entry>();
  private readonly diagnostics: string[] = [];
  private integrity = true;
  private readonly options: ActionStoreOptions;

  constructor(options: ActionStoreOptions) {
    if (typeof options.validate !== 'function') throw new Error('Action validation is required');
    // Keep configuration/genesis insulated from later caller mutations as well.
    this.options = { ...options, genesisAllocations: structuredClone(options.genesisAllocations) };
    this.envelopes.observe((event) => {
      for (const delta of event.changes.delta) {
        if (delta.delete) {
          this.integrity = false;
          this.diagnostics.push('Canonical envelope deletion violates append-only storage');
        }
        if (delta.insert) {
          if (!Array.isArray(delta.insert)) {
            this.integrity = false;
            this.diagnostics.push('Canonical collection contains a non-array insertion');
          } else for (const bytes of delta.insert) this.collect(bytes);
        }
      }
    });
  }

  append(action: ActionEnvelope): void {
    this.appendEncoded(encodeEnvelope(action));
  }

  /** Also retains malformed/unsupported envelopes for diagnostics and lossless exchange. */
  appendEncoded(bytes: Uint8Array): void {
    this.envelopes.push([bytes.slice()]);
  }

  applyUpdate(update: Uint8Array): void {
    // An already-deleted entry in a checkpoint never produces an observer delete event.
    // Reject native deletion before integration, including on cold restore.
    if (Y.decodeUpdate(update).ds.clients.size) {
      this.integrity = false;
      const message = 'Canonical update deletion violates append-only storage';
      this.diagnostics.push(message);
      throw new Error(message);
    }
    Y.applyUpdate(this.doc, update);
  }

  encodeUpdate(stateVector?: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** Persistence/provider hook. Each listener receives its own copy of the update. */
  onUpdate(listener: (update: Uint8Array) => void): () => void {
    const callback = (update: Uint8Array) => listener(update.slice());
    this.doc.on('update', callback);
    return () => this.doc.off('update', callback);
  }

  /** Detached binding and a fresh reader with the same genesis/validator for checkpoint validation. */
  get identity() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      documentId: this.options.documentId,
      genesisId: this.options.genesisId,
    };
  }

  emptyClone(): ActionStore {
    return new ActionStore(this.options);
  }

  /** Actual stored records, including duplicates/anonymous payloads and unresolved outer structs. */
  retainedBytes() {
    const update = this.encodeUpdate();
    let envelopePayloadBytes = 0;
    let nativeInsertionBodyBytes = 0;
    let envelopeRecords = 0;
    // Full export includes pending structs. ContentBinary is the native encoding of each
    // envelope-array byte record; count stored entries rather than deduplicated variants.
    for (const struct of Y.decodeUpdate(update).structs) {
      if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentBinary)) continue;
      const bytes = struct.content.content;
      envelopeRecords++;
      envelopePayloadBytes += bytes.byteLength;
      try {
        const envelope = decodeEnvelope(bytes);
        nativeInsertionBodyBytes += envelope.nativeInsertUpdates.reduce(
          (n, body) => n + body.byteLength,
          0,
        );
      } catch (error) {
        if (!(error instanceof EnvelopeDecodeError)) throw error;
        // Undecodable payloads remain in the total; their native subset is unknown.
      }
    }
    return {
      envelopeRecords,
      envelopePayloadBytes,
      nativeInsertionBodyBytes,
      actionDocUpdateBytes: update.byteLength,
    };
  }

  destroy(): void {
    this.doc.destroy();
  }

  private collect(value: unknown): void {
    if (!(value instanceof Uint8Array)) {
      this.integrity = false;
      this.diagnostics.push('Canonical collection entry must be an encoded envelope');
      return;
    }
    const bytes = value.slice();
    let id: ActionId;
    let variant: Variant;
    try {
      const envelope = decodeEnvelope(bytes);
      id = envelope.id;
      variant = { bytes, envelope };
    } catch (error) {
      if (!(error instanceof EnvelopeDecodeError)) throw error;
      if (!error.id) {
        this.diagnostics.push(error.message);
        return;
      }
      id = error.id;
      variant = { bytes, reason: error.reason };
    }
    const key = actionKey(id);
    const entry = this.entries.get(key) ?? { id, variants: [] };
    if (!entry.variants.some((item) => compareBytes(item.bytes, bytes) === 0)) {
      entry.variants.push(variant);
      entry.variants.sort((a, b) => compareBytes(a.bytes, b.bytes));
    }
    this.entries.set(key, entry);
  }

  snapshot(): ActionStoreSnapshot {
    const entries = [...this.entries.values()].sort((a, b) => compareIds(a.id, b.id));
    const states = new Map<string, ActionReadiness>();
    const candidates: ActionEnvelope[] = [];
    for (const entry of entries) {
      const key = actionKey(entry.id);
      const variant = entry.variants[0];
      if (entry.variants.length > 1) states.set(key, quarantined('fork'));
      else if (!variant.envelope) states.set(key, quarantined(variant.reason!));
      else {
        const action = variant.envelope;
        const reason = this.chainError(action);
        if (reason) states.set(key, quarantined(reason));
        else candidates.push(action);
      }
    }
    // Reject impossible known causal edges before topological evaluation, including cycles.
    for (const action of candidates) {
      const dependencies = action.dependencies.map((id) => this.entries.get(actionKey(id)));
      if (
        dependencies.some(
          (entry) =>
            entry?.variants.length === 1 &&
            entry.variants[0].envelope &&
            entry.variants[0].envelope.lamport >= action.lamport,
        )
      )
        states.set(actionKey(action.id), quarantined('actor-chain'));
    }
    candidates.sort(compareActions);
    const ready = new Map<string, ActionEnvelope>();
    for (const action of candidates) {
      const key = actionKey(action.id);
      if (states.has(key)) continue;
      const dependencies = [...action.dependencies].sort(compareIds);
      const invalid = dependencies
        .map((id) => states.get(actionKey(id)))
        .find((state) => state?.state === 'quarantined');
      if (invalid?.state === 'quarantined') {
        states.set(key, quarantined(invalid.reason));
        continue;
      }
      const missing = new Map<string, ActionId>();
      for (const id of dependencies) {
        const state = states.get(actionKey(id));
        if (!state) missing.set(actionKey(id), id);
        else if (state.state === 'pending')
          for (const absent of state.missing) missing.set(actionKey(absent), absent);
      }
      if (missing.size) {
        states.set(key, { state: 'pending', missing: [...missing.values()].sort(compareIds) });
        continue;
      }
      const maxTime = dependencies.reduce((max, id) => {
        const time = ready.get(actionKey(id))!.lamport;
        return time > max ? time : max;
      }, 0n);
      if (action.lamport !== maxTime + 1n) {
        states.set(key, quarantined('actor-chain'));
        continue;
      }
      const closure = new Map<string, ActionEnvelope>();
      const stack = [...dependencies];
      while (stack.length) {
        const id = stack.pop()!;
        const depKey = actionKey(id);
        if (closure.has(depKey)) continue;
        const ancestor = ready.get(depKey)!;
        closure.set(depKey, ancestor);
        stack.push(...ancestor.dependencies);
      }
      const causalBase = [...closure.values()].sort(compareActions);
      // Pass detached values to validators; neither validator nor snapshot callers own facts.
      const reason = !validReferences(action, causalBase, this.options.genesisAllocations)
        ? 'reference'
        : this.options.validate(structuredClone(action), {
            dependencies: structuredClone(causalBase),
          });
      states.set(key, reason ? quarantined(reason) : { state: 'ready' });
      if (!reason) ready.set(key, action);
    }
    const heads = new Map([...ready].map(([key, action]) => [key, action.id]));
    for (const action of ready.values())
      for (const id of action.dependencies) heads.delete(actionKey(id));
    return structuredClone({
      actions: entries.map((entry) => ({
        id: entry.id,
        variants: entry.variants.map((variant) => variant.bytes),
        readiness: states.get(actionKey(entry.id))!,
      })),
      ready: this.integrity ? [...ready.values()] : [],
      heads: this.integrity ? [...heads.values()] : [],
      diagnostics: this.diagnostics,
      integrity: this.integrity,
    });
  }

  private chainError(action: ActionEnvelope): QuarantineReason | null {
    if (
      action.documentId !== this.options.documentId ||
      action.genesisId !== this.options.genesisId
    )
      return 'reference';
    if (
      action.id.sequence === 0n ||
      action.lamport === 0n ||
      action.groupId.session.actor !== action.id.actor
    )
      return 'actor-chain';
    const keys = action.dependencies.map(actionKey);
    if (new Set(keys).size !== keys.length || keys.includes(actionKey(action.id)))
      return 'actor-chain';
    if (
      action.dependencies.some(
        (id) =>
          id.sequence === 0n || (id.actor === action.id.actor && id.sequence >= action.id.sequence),
      )
    )
      return 'actor-chain';
    if (
      action.id.sequence > 1n &&
      !keys.includes(
        actionKey({
          actor: action.id.actor,
          sequence: action.id.sequence - 1n,
        }),
      )
    )
      return 'actor-chain';
    return null;
  }
}
