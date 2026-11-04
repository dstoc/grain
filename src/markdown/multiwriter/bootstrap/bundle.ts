import { encodeCbor } from '../actions/cbor.js';
import { actorId } from '../contracts.js';
import type { DeliveryRoute, SessionId } from '../contracts.js';
import { DirectionalActionProvider } from '../providers/index.js';
import type { ProviderOptions } from '../providers/index.js';
import { openReferenceDocument } from '../reference/document.js';
import {
  BootstrapCompatibilityError,
  bootstrapLimits,
  checkBytes,
  decodeGenesis,
  readWire,
  referenceGenesis,
  requireSameGenesis,
} from './descriptor.js';
import type { BootstrapLimits } from './descriptor.js';

export interface BootstrapBundle {
  readonly genesis: Uint8Array;
  readonly actionUpdate: Uint8Array;
}
/** Exact keys for bootstrap v1. The carrier is complete, including unresolved structs. */
export function encodeBundle(
  bundle: BootstrapBundle,
  limits?: Partial<BootstrapLimits>,
): Uint8Array {
  const bytes = encodeCbor({
    protocolVersion: 3n,
    bootstrapVersion: 1n,
    genesis: bundle.genesis,
    actionUpdate: bundle.actionUpdate,
  });
  checkBytes(bytes, bootstrapLimits(limits));
  return bytes;
}
export function decodeBundle(bytes: Uint8Array, input?: Partial<BootstrapLimits>): BootstrapBundle {
  const wire = readWire(bytes, bootstrapLimits(input));
  if (!wire || typeof wire !== 'object' || Array.isArray(wire) || wire instanceof Uint8Array)
    throw new BootstrapCompatibilityError('Invalid bootstrap bundle');
  const fields = wire as Record<string, unknown>;
  if (fields.protocolVersion !== 3n || fields.bootstrapVersion !== 1n)
    throw new BootstrapCompatibilityError('Unsupported bundle protocol/bootstrap version');
  if (
    Object.keys(fields).length !== 4 ||
    !(fields.genesis instanceof Uint8Array) ||
    !(fields.actionUpdate instanceof Uint8Array)
  )
    throw new BootstrapCompatibilityError('Invalid bootstrap bundle fields');
  return { genesis: fields.genesis, actionUpdate: fields.actionUpdate };
}
export interface BootstrapOpenOptions extends Omit<ProviderOptions, 'store'> {
  /** Descriptor supplied by creation, a remote bundle, or existing host metadata. */
  readonly genesis: Uint8Array;
  /** Host must load/install immutable metadata before attaching this namespace's journal. */
  readonly persistedGenesis: Uint8Array | undefined;
  readonly bootstrapLimits?: Partial<BootstrapLimits>;
}
/** Own-journal restoration is local. Remote bundle tails must use receiveBundle afterward.
 * Authoring stays suspended until this resolves. Navigation/writer state belongs to callers.
 */
export async function openBootstrap(options: BootstrapOpenOptions) {
  const bytes = options.genesis.slice();
  requireSameGenesis(options.persistedGenesis, bytes);
  const limits = bootstrapLimits(options.bootstrapLimits);
  const descriptor = decodeGenesis(bytes, limits);
  const document = openReferenceDocument(referenceGenesis(descriptor), {
    nativeDecodeOperations: limits.nativeOperations,
  });
  let attachment: DirectionalActionProvider | undefined;
  try {
    attachment = await DirectionalActionProvider.open({
      store: document.store,
      journal: options.journal,
      mode: options.mode,
      limits: options.limits,
      restoreOperations: options.restoreOperations,
      onError: options.onError,
    });
    // Opening must expose a usable complete publication, or fail and release resources.
    let projection = document.publication.refresh();
    while (projection.state === 'deferred') {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      projection = projection.continuation.resume();
    }
  } catch (error) {
    // Provider.open closes the journal if restoration fails. After attachment, close owns it.
    // No writer can append until this function returns.
    try {
      await attachment?.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Bootstrap opening and journal close failed');
    } finally {
      document.destroy();
    }
    throw error;
  }
  const provider = attachment;
  const session: Readonly<SessionId> = Object.freeze({
    actor: actorId(
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''),
    ),
    local: crypto.randomUUID(),
  });
  return {
    session,
    document,
    provider,
    genesisBytes: () => bytes.slice(),
    captureBundle: () =>
      encodeBundle({ genesis: bytes, actionUpdate: document.store.encodeUpdate() }, limits),
    receiveBundle(route: DeliveryRoute, bundleBytes: Uint8Array) {
      const bundle = decodeBundle(bundleBytes, limits);
      requireSameGenesis(bytes, bundle.genesis);
      return provider.receiveResult(route, bundle.actionUpdate);
    },
    /** Stop host authoring first; failed persistence leaves the attachment available for retry. */
    async close() {
      await provider.close();
      document.destroy();
    },
  };
}
