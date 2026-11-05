import type { Edit } from '../../../editing/outcomes.js';
import { LocalEditor, RetainedEditError } from '../authoring/index.js';
import type { LocalEditResult } from '../authoring/index.js';
import { decodeGenesis, openBootstrap, referenceGenesis } from '../bootstrap/index.js';
import type { BootstrapLimits, BootstrapOpenOptions } from '../bootstrap/index.js';
import type { ActionId, DeliveryRoute, NodeId, ProjectionAddress, SyncMode } from '../contracts.js';
import type { HistoryOptions, ManagedEditOptions, NavigationOptions } from '../history/index.js';
import { resolveSelection, type StableSelection } from '../history/index.js';
import type { HistoryPublication } from '../history/selection.js';
import type { Continuation } from '../ingest/work.js';
import { assertLimit } from '../ingest/work.js';
import type { PeerTransport, ProviderLimits } from '../providers/index.js';

export interface ReplicaOptions extends BootstrapOpenOptions {
  readonly history?: HistoryOptions;
  /** Reference publication work per refresh. Resume with retryPublication(). */
  readonly publicationOperations?: number;
}
export type ReplicaEvent = 'publication' | 'history' | 'mode' | 'closing' | 'closed';
type Bootstrap = Awaited<ReturnType<typeof openBootstrap>>;

/** Experimental reference-backed composition. Normal browser cutover requires MW-13.
 * One instance owns one provider, native writer and managed navigation session.
 * Account labels belong to hosts and are never authoring identities.
 */
export class Replica {
  private readonly editor: LocalEditor;
  private readonly history;
  private readonly listeners = new Set<(event: ReplicaEvent) => void>();
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private mode: SyncMode;
  private busy = false;
  private notifying = false;
  private closing?: Promise<void>;
  private pending?: { version: number; continuation: Continuation<HistoryPublication> };
  private last: HistoryPublication;
  private failure?: { error: unknown };
  private observerFailures: unknown[] = [];
  private version = 0;
  private edits = 0;
  private controls = 0;
  private retained?: { action: ActionId; selection?: StableSelection };
  private constructor(
    private readonly boot: Bootstrap,
    private readonly options: ReplicaOptions,
  ) {
    this.mode = options.mode;
    this.editor = new LocalEditor(
      boot.document,
      referenceGenesis(decodeGenesis(boot.genesisBytes(), options.bootstrapLimits)),
    );
    this.history = this.editor.session('editor', options.history);
    this.last = boot.document.publication.status().publication!;
  }
  static async open(options: ReplicaOptions): Promise<Replica> {
    assertLimit(options.publicationOperations ?? 10_000);
    const boot = await openBootstrap(options);
    try {
      return new Replica(boot, options);
    } catch (error) {
      await boot.close();
      throw error;
    }
  }
  /** Last complete tree, addresses and native view are published as one value. */
  publication(): HistoryPublication {
    return this.last;
  }
  status() {
    return {
      lifecycle: this.lifecycle,
      mode: this.mode,
      version: this.version,
      localEdits: this.edits,
      localControls: this.controls,
      canAuthor:
        this.lifecycle === 'open' &&
        !this.pending &&
        !this.failure &&
        this.boot.document.publication.status().canAuthor,
      deferred: !!this.pending,
      error: this.failure?.error,
      observerErrors: [...this.observerFailures],
      history: this.history.status(),
    };
  }
  /** Notifications never abort canonical append or provider cleanup. */
  subscribe(listener: (event: ReplicaEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(event: ReplicaEvent) {
    this.notifying = true;
    try {
      for (const listener of Array.from(this.listeners)) {
        try {
          listener(event);
        } catch (error) {
          this.observerFailures.push(error);
          if (this.observerFailures.length > 20) this.observerFailures.shift();
        }
      }
    } finally {
      this.notifying = false;
    }
  }
  private assertOpen() {
    if (this.lifecycle !== 'open') throw new Error(`Replica is ${this.lifecycle}`);
    if (this.busy || this.notifying) throw new Error('Recursive replica mutation is not allowed');
  }
  /** Resolve immediately before dispatch; handles are local to the current publication. */
  handle(node: NodeId) {
    this.assertOpen();
    if (!this.status().canAuthor) throw new Error('Replica publication is not authorable');
    return this.editor.handle(node);
  }
  edit<Input>(command: Edit<Input>, input: Input, options: ManagedEditOptions = {}) {
    return this.mutate(() => this.history.edit(command, input, options));
  }
  editEmptyRoot(text: string): LocalEditResult {
    return this.mutate(() => this.history.editEmptyRoot(text));
  }
  undo(options: NavigationOptions = {}) {
    return this.mutate(() => this.history.undo(options), 'control');
  }
  redo(options: NavigationOptions = {}) {
    return this.mutate(() => this.history.redo(options), 'control');
  }
  sealGroup(): void {
    this.assertOpen();
    this.history.sealGroup();
  }
  private mutate<T>(action: () => T, kind: 'edit' | 'control' = 'edit'): T {
    this.assertOpen();
    if (!this.status().canAuthor) throw new Error('Replica publication is not authorable');
    this.busy = true;
    const before = this.boot.document.store.factsVersion;
    try {
      return action();
    } catch (error) {
      if (error instanceof RetainedEditError) {
        const same = (id: ActionId | null) =>
          id?.actor === error.action.actor && id.sequence === error.action.sequence;
        const groups = this.history.groups();
        const undone = groups.redo.find((group) => same(group.previousControl));
        const applied = groups.undo.find(
          (group) => group.actions.some(same) || same(group.previousControl),
        );
        this.retained = {
          action: structuredClone(error.action),
          selection: undone?.selectionBefore ?? applied?.selectionAfter,
        };
      }
      throw error;
    } finally {
      // RetainedEditError means the append happened. Never replay the command.
      try {
        if (this.boot.document.store.factsVersion !== before) {
          if (kind === 'edit') this.edits++;
          else this.controls++;
        }
        const current = this.boot.document.publication.status();
        if (current.publication && !current.stale) {
          const changed = this.last.value !== current.publication.value;
          this.last = current.publication;
          this.failure = undefined;
          if (changed) {
            this.version++;
            this.notify('publication');
          }
        }
        this.notify('history');
      } finally {
        this.busy = false;
      }
    }
  }
  /** Recover the exact staged history selection after a retained operation fails.
   * Call after publication recovery; this never repeats the semantic command.
   */
  retainedRestoration(action: ActionId, host?: ProjectionAddress) {
    if (
      !this.retained ||
      this.retained.action.actor !== action.actor ||
      this.retained.action.sequence !== action.sequence ||
      !this.status().canAuthor
    )
      return;
    return resolveSelection(
      this.last,
      this.retained.selection,
      host ?? this.retained.selection?.focus.host ?? this.last.value.view.root.origin,
      !!this.last.value.view.emptyRoot,
    );
  }
  setMode(mode: SyncMode): void {
    this.assertOpen();
    this.boot.provider.setMode(mode);
    this.mode = mode;
    this.notify('mode');
  }
  attachPeer(id: string, transport: PeerTransport): () => void {
    this.assertOpen();
    return this.boot.provider.attachPeer(id, transport);
  }
  publish(): Promise<void> {
    this.assertOpen();
    return this.boot.provider.publish();
  }
  receive(route: DeliveryRoute, update: Uint8Array) {
    this.assertOpen();
    const result = this.boot.provider.receiveResult(route, update);
    if (result.state === 'admitted') this.refresh();
    return result;
  }
  receiveBundle(route: DeliveryRoute, bytes: Uint8Array, limits?: Partial<BootstrapLimits>) {
    this.assertOpen();
    const result = this.boot.receiveBundle(route, bytes, limits);
    if (result.state === 'admitted') this.refresh();
    return result;
  }
  private refresh() {
    this.pending?.continuation.cancel();
    this.pending = undefined;
    this.advance(() => this.boot.document.publication.refresh(this.options.publicationOperations));
  }
  private advance(compute: () => ReturnType<Bootstrap['document']['publication']['refresh']>) {
    this.failure = undefined;
    try {
      const result = compute();
      if (result.state === 'deferred') {
        this.pending = {
          version: this.boot.document.store.factsVersion,
          continuation: result.continuation,
        };
      } else {
        this.pending = undefined;
        this.last = result.value;
        this.version++;
      }
    } catch (error) {
      this.pending = undefined;
      this.failure = { error };
      throw error;
    } finally {
      this.notify('publication');
    }
  }
  retryPublication(operations = this.options.publicationOperations): void {
    this.assertOpen();
    if (operations !== undefined) assertLimit(operations);
    const pending = this.pending;
    this.pending = undefined;
    if (pending && pending.version === this.boot.document.store.factsVersion)
      this.advance(() => pending.continuation.resume(operations));
    else {
      pending?.continuation.cancel();
      this.advance(() => this.boot.document.publication.refresh(operations));
    }
  }
  setNativeDecodeLimit(operations: number): void {
    this.assertOpen();
    this.pending?.continuation.cancel();
    this.pending = undefined;
    this.boot.document.setNativeDecodeLimit(operations);
    this.refresh();
  }
  setProviderLimits(limits: Partial<ProviderLimits>): void {
    this.assertOpen();
    this.boot.provider.setLimits(limits);
  }
  captureBundle(limits?: Partial<BootstrapLimits>): Uint8Array {
    return this.boot.captureBundle(limits);
  }
  /** Detached original carrier bytes, including unresolved structs. Diagnostic/export only. */
  retainedUpdate(): Uint8Array {
    return this.boot.document.store.encodeUpdate();
  }
  capturePersistence() {
    this.assertOpen();
    return this.boot.provider.capturePublication();
  }
  flush(): Promise<void> {
    return this.boot.provider.flush();
  }
  retryPersistence(): Promise<void> {
    return this.boot.provider.retryPersistence();
  }
  close(): Promise<void> {
    if (this.lifecycle === 'closed') return Promise.resolve();
    if (this.closing) return this.closing;
    if (this.busy || this.notifying) throw new Error('Cannot close during a replica mutation');
    // Fence BOTH command callers and ingress before provider unsubscription.
    this.lifecycle = 'closing';
    this.pending?.continuation.cancel();
    this.pending = undefined;
    this.history.sealGroup();
    this.closing = Promise.resolve()
      .then(() => this.boot.close())
      .then(() => {
        this.editor.destroy();
        this.lifecycle = 'closed';
        this.notify('closed');
        this.listeners.clear();
      })
      .finally(() => {
        this.closing = undefined;
      });
    this.notify('closing');
    return this.closing;
  }
}
export const openReplica = (options: ReplicaOptions): Promise<Replica> => Replica.open(options);
