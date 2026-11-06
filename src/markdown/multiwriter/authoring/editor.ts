import { measure } from '../diagnostics.js';
import type { ReadySequence } from './ready-source.js';
import { decodeUpdate, Item } from 'yjs';
import { encodeEnvelope } from '../actions/codec.js';
import { compareBytes } from '../actions/cbor.js';
import { classifyInlineInput } from '../../block-parser/api.js';
import type { ParserConversionPlan } from '../../block-parser/types.js';
import { assertScopedTarget } from '../../../editing/context.js';
import type { Edit, EditOutcome } from '../../../editing/outcomes.js';
import type { EditSelection } from '../../semantic/selection.js';
import type { NodeId as Handle } from '../../semantic/types.js';
import { actorId, assertCounter } from '../contracts.js';
import type { ActionEnvelope, ActionId, GroupId, NodeId } from '../contracts.js';
import type { ReferenceGenesis } from '../reference/document.js';
import type { AuthoringDocument } from './document.js';
import { resourceKey } from '../layout/index.js';
import { NativeTapeCache } from '../text/cache.js';
import { textPoint, requestEmptyRootEdit } from '../projection/addresses.js';
import type { TextPoint } from '../projection/addresses.js';
import type { ViewNode } from '../projection/types.js';
import type { PreparedNativeBody } from '../text/types.js';
import { RetainedEditError } from './errors.js';
export { RetainedEditError } from './errors.js';
import { HistorySession } from '../history/session.js';
import type { HistoryOptions, RetainedEdit } from '../history/session.js';
import { capturePoint } from '../history/selection.js';
import { captureFootprint } from '../history/scope.js';
import { reconstructProvenance } from '../reference/provenance.js';
import { projectMarkdown } from '../projection/project.js';
import { nativeView } from '../ingest/publication.js';
import type { StableSelection } from '../history/selection.js';
export type { StableSelection } from '../history/selection.js';
import { commandViewIndex } from './view-index.js';
import { readySource } from './ready-source.js';
import type { ReadySource } from './ready-source.js';
import { MultiwriterCommandDraft } from './draft.js';
import { CommandCompiler, ConversionDeclined } from './compiler.js';

export interface AuthorSession {
  readonly local: string;
  readonly group: bigint;
}
export type LocalEditResult =
  | { readonly status: 'not-applicable' | 'unchanged'; readonly applied: false }
  | {
      readonly status: 'declined';
      readonly applied: false;
      readonly reason: 'unsupported-conversion' | 'invalid-conversion';
      readonly message: string;
    }
  | {
      readonly status: 'applied';
      readonly applied: true;
      readonly action: ActionId;
      readonly group: GroupId;
      readonly envelope: ActionEnvelope;
      readonly outcome: EditOutcome;
      readonly focus?: TextPoint;
      readonly selectionBefore?: StableSelection;
      readonly selectionAfter?: StableSelection;
      readonly footprint: Pick<ActionEnvelope, 'allocations' | 'effects'>;
    };
export interface LocalEditOptions {
  readonly scopeRoot?: Handle;
  /** Initiating editor host, independent of the command scope. Defaults to document root. */
  readonly hostRoot?: Handle;
  readonly selectionBefore?: EditSelection;
  readonly conversion?: { readonly nodeId: Handle; readonly plan: ParserConversionPlan };
  readonly promote?: Handle;
}

/** Synchronous local writer; transport and durability belong to an attached provider.
 * This implementation uses the reference reducer. It is not the MW-13 release fast path.
 */
export class LocalEditor {
  private readonly actor = actorId(
    [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  );
  private native: NativeTapeCache;
  private readonly nativeDecodeOperations?: number;
  private sequence = 0n;
  private editing = false;
  private closed = false;
  private applied = new Set<string>();
  private synced?: ReadySource;
  private readonly ahead = new Set<string>();
  private readonly writerWork = {
    readyActionsScanned: 0,
    readyIndexNodesVisited: 0,
    nativeBodiesApplied: 0,
    nativeRebuilds: 0,
    frontierActionsScanned: 0,
  };
  writerDiagnostics() {
    return { ...this.writerWork };
  }
  private readonly sessions = new Map<string, HistorySession>();
  private readonly unmanaged = new Set<string>();
  /** A live session's identity cannot also be used by the low-level writer. */
  session(local = 'default', options: HistoryOptions = {}): HistorySession {
    if (this.closed) throw new Error('Local editor is closed');
    if (!local) throw new Error('Session must have a local identity');
    if (this.unmanaged.has(local))
      throw new Error('Session was already used by the low-level writer');
    let session = this.sessions.get(local);
    if (!session) {
      session = new HistorySession(
        local,
        {
          publication: () => this.current(),
          version: () => this.document.store.factsVersion,
          capture: (options) => this.captureSelection(options),
          edit: (group, command, input, options, register) =>
            this.performEdit({ local, group }, command, input, options, register),
          control: (group, effect, register) =>
            this.performControl({ local, group }, effect, register),
          empty: (group, text, register) => this.performEmptyRoot({ local, group }, text, register),
        },
        options,
      );
      this.sessions.set(local, session);
    }
    return session;
  }
  private current() {
    if (this.closed) throw new Error('Local editor is closed');
    const status = this.document.publication.status();
    if (status.stale || !status.canAuthor || !status.publication)
      throw new Error('Publication is stale or not authorable; refresh before editing');
    return status.publication;
  }
  private captureSelection(options: LocalEditOptions): StableSelection | undefined {
    return measure('selection-address', () => this.captureSelectionMeasured(options));
  }
  private captureSelectionMeasured(options: LocalEditOptions): StableSelection | undefined {
    const selection = options.selectionBefore;
    if (!selection) return undefined;
    const p = this.current(),
      draft = new MultiwriterCommandDraft(
        p.value.view.root,
        this.document.commandMode === 'overlay',
      );
    const host = options.hostRoot ? draft.origins.get(options.hostRoot) : p.value.view.root;
    if (!host) throw new Error('Selection has no projected host');
    const stable = (point: EditSelection['anchor']) => {
      const node = draft.origins.get(point.nodeId);
      if (!node) throw new Error('Selection has no projected origin');
      assertScopedTarget(draft, options.scopeRoot ?? draft.rootId, point.nodeId);
      assertScopedTarget(draft, options.hostRoot ?? draft.rootId, point.nodeId);
      return capturePoint(p, node, point.offset, point.affinity, host);
    };
    return structuredClone({
      anchor: stable(selection.anchor),
      focus: stable(selection.focus),
      ...('nodeIds' in selection
        ? {
            blocks: selection.nodeIds.map((id) => {
              assertScopedTarget(draft, options.scopeRoot ?? draft.rootId, id);
              const node = draft.origins.get(id);
              if (!node) throw new Error('Selected block has no projected origin');
              return node.origin;
            }),
          }
        : {}),
    });
  }
  private base(session: AuthorSession) {
    const p = this.current(),
      ready = this.document.readyActions?.() ?? this.document.store.snapshot().ready;
    this.sync(ready);
    const source = readySource(ready);
    const knownSequence =
      source?.sequence(this.actor) ??
      Array.from(ready).reduce((n, a) => {
        this.writerWork.frontierActionsScanned++;
        return a.id.actor === this.actor && a.id.sequence > n ? a.id.sequence : n;
      }, 0n);
    const previousSequence = knownSequence > this.sequence ? knownSequence : this.sequence;
    const id = { actor: this.actor, sequence: previousSequence + 1n };
    const lamport =
      (source?.maxLamport ??
        Array.from(ready).reduce((max, a) => {
          this.writerWork.frontierActionsScanned++;
          return a.lamport > max ? a.lamport : max;
        }, 0n)) + 1n;
    assertCounter(id.sequence);
    assertCounter(lamport);
    const dependencies = [...p.heads];
    if (
      previousSequence > 0n &&
      !dependencies.some((d) => d.actor === this.actor && d.sequence === previousSequence)
    )
      dependencies.push({ actor: this.actor, sequence: previousSequence });
    return {
      protocolVersion: 3 as const,
      documentId: this.genesis.documentId,
      genesisId: this.genesis.genesisId,
      id,
      lamport,
      dependencies,
      groupId: { session: { actor: this.actor, local: session.local }, sequence: session.group },
    };
  }
  /** The only append boundary for both commands and controls. */
  private append(
    envelope: ActionEnvelope,
    prepared: PreparedNativeBody | undefined,
    register: () => void,
  ): void {
    return measure('canonical-append', () => this.appendMeasured(envelope, prepared, register));
  }
  private appendMeasured(
    envelope: ActionEnvelope,
    prepared: PreparedNativeBody | undefined,
    register: () => void,
  ): void {
    let appended = false;
    const retain = () => {
      prepared?.commit();
      this.applied.add(`${envelope.id.actor}:${envelope.id.sequence}`);
      this.ahead.add(`${envelope.id.actor}:${envelope.id.sequence}`);
      this.sequence = envelope.id.sequence;
      register();
    };
    try {
      this.document.certifyLocal(envelope);
      this.document.store.append(envelope);
      appended = true;
    } catch (error) {
      const bytes = encodeEnvelope(envelope);
      appended = decodeUpdate(this.document.store.encodeUpdate()).structs.some(
        (struct) =>
          struct instanceof Item &&
          struct.content
            .getContent()
            .some((value) => value instanceof Uint8Array && compareBytes(value, bytes) === 0),
      );
      if (appended) retain();
      else prepared?.abort();
      throw error;
    }
    retain();
  }
  private performControl(
    session: AuthorSession,
    effect: Extract<ActionEnvelope['effects'][number], { type: 'SetGroupActive' }>,
    register: (id: ActionId) => void,
  ) {
    return measure(
      'draft-query',
      () => this.performControlMeasured(session, effect, register),
      'author',
    );
  }
  private performControlMeasured(
    session: AuthorSession,
    effect: Extract<ActionEnvelope['effects'][number], { type: 'SetGroupActive' }>,
    register: (id: ActionId) => void,
  ) {
    if (this.editing) throw new Error('Recursive local editing is not allowed');
    this.editing = true;
    let retained: ActionId | undefined;
    try {
      const base = this.base(session);
      const dependencies = [
        ...new Map(
          [
            ...base.dependencies,
            ...effect.actions,
            ...(effect.previousControl ? [effect.previousControl] : []),
          ].map((id) => [`${id.actor}:${id.sequence}`, id]),
        ).values(),
      ];
      const envelope: ActionEnvelope = {
        ...base,
        dependencies,
        allocations: [],
        nativeManifest: [],
        nativeInsertUpdates: [],
        effects: [structuredClone(effect)],
      };
      this.append(envelope, undefined, () => {
        retained = envelope.id;
        register(envelope.id);
      });
      const publication = this.refresh();
      return { action: envelope.id, publication };
    } catch (error) {
      if (retained) throw new RetainedEditError(retained, error);
      throw error;
    } finally {
      this.editing = false;
    }
  }
  constructor(
    readonly document: AuthoringDocument,
    private readonly genesis: ReferenceGenesis,
    options: { readonly nativeDecodeOperations?: number } = {},
  ) {
    this.genesis = structuredClone(genesis);
    this.nativeDecodeOperations = options.nativeDecodeOperations;
    this.native = new NativeTapeCache(this.nativeDecodeOperations);
    this.native.apply('genesis', this.genesis.body);
  }
  get nativeClientId(): number {
    return this.native.clientId;
  }
  /** Handles are local to the current projection and never enter an envelope. */
  handle(node: NodeId): Handle {
    const p = this.document.publication.status().publication;
    if (!p) throw new Error('Document has no publication');
    const found = commandViewIndex(p.value.view.root).handleOrigin(node);
    if (!found) throw new Error('Node is not in the current projection');
    return found;
  }
  private sync(ready: ReadySequence) {
    const source = readySource(ready);
    const delta =
      source && this.synced && [...this.ahead].every((key) => source.has(key))
        ? source.additions(this.synced)
        : undefined;
    this.synced = undefined;
    if (delta) this.writerWork.readyIndexNodesVisited += delta.nodesVisited;
    else {
      const keys = new Set(Array.from(ready).map((a) => `${a.id.actor}:${a.id.sequence}`));
      this.writerWork.readyActionsScanned += ready.length;
      if ([...this.applied].some((k) => !keys.has(k))) {
        this.native.destroy();
        this.native = new NativeTapeCache(this.nativeDecodeOperations);
        this.native.apply('genesis', this.genesis.body);
        this.applied.clear();
        this.writerWork.nativeRebuilds++;
      }
    }
    const additions = delta?.actions ?? ready;
    if (!delta) this.writerWork.readyActionsScanned += additions.length;
    for (const a of additions) {
      const key = `${a.id.actor}:${a.id.sequence}`;
      if (!this.applied.has(key)) {
        this.native.apply(key, a);
        this.applied.add(key);
        this.writerWork.nativeBodiesApplied++;
      }
    }
    this.ahead.clear();
    this.synced = source;
  }
  edit<Input>(
    session: AuthorSession,
    command: Edit<Input>,
    input: Input,
    options: LocalEditOptions = {},
  ): LocalEditResult {
    if (this.sessions.has(session.local))
      throw new Error('Session is managed; use its history facade');
    this.unmanaged.add(session.local);
    return this.performEdit(session, command, input, options);
  }
  private performEdit<Input>(
    session: AuthorSession,
    command: Edit<Input>,
    input: Input,
    options: LocalEditOptions = {},
    register?: (edit: RetainedEdit) => void,
  ): LocalEditResult {
    return measure(
      'draft-query',
      () => this.performEditMeasured(session, command, input, options, register),
      'author',
    );
  }
  private performEditMeasured<Input>(
    session: AuthorSession,
    command: Edit<Input>,
    input: Input,
    options: LocalEditOptions = {},
    register?: (edit: RetainedEdit) => void,
  ): LocalEditResult {
    if (this.closed) throw new Error('Local editor is closed');
    if (this.editing) throw new Error('Recursive local editing is not allowed');
    if (!session.local) throw new Error('Session must have a local identity');
    assertCounter(session.group);
    this.editing = true;
    let retained: ActionId | undefined;
    try {
      const status = this.document.publication.status();
      if (status.stale || !status.canAuthor || !status.publication)
        throw new Error('Publication is stale or not authorable; refresh before editing');
      const p = status.publication,
        ready = this.document.readyActions?.() ?? this.document.store.snapshot().ready;
      this.sync(ready);
      const draft = new MultiwriterCommandDraft(
        p.value.view.root,
        this.document.commandMode === 'overlay',
      );
      const selectionBefore = this.captureSelection(options);
      const outcome = command(
        {
          draft,
          scopeRoot: options.scopeRoot ?? draft.rootId,
          ...(options.selectionBefore ? { selectionBefore: options.selectionBefore } : {}),
        },
        input,
      );
      if (outcome.status === 'not-applicable') {
        if (draft.intents.length) throw new Error('Inapplicable command mutated its draft');
        return { status: 'not-applicable', applied: false };
      }
      if (!draft.intents.length) return { status: 'unchanged', applied: false };
      const base = this.base(session),
        id = base.id;
      const makeCompiler = () => {
        const c = new CommandCompiler(
          this.genesis,
          ready,
          base,
          draft,
          p.value.view.root,
          p.native,
          this.document.commandMode === 'overlay' ? p.value : undefined,
          this.document.createCommandOwnership?.(),
        );
        c.run();
        return c;
      };
      let compiler = makeCompiler();
      if (options.conversion) {
        assertScopedTarget(draft, options.scopeRoot ?? draft.rootId, options.conversion.nodeId);
        try {
          compiler.interpret(options.conversion.nodeId, options.conversion.plan);
        } catch (error) {
          if (!(error instanceof ConversionDeclined)) throw error;
          return {
            status: 'declined',
            applied: false,
            reason: error.reason,
            message: error.message,
          };
        }
      }
      if (options.promote) {
        assertScopedTarget(draft, options.scopeRoot ?? draft.rootId, options.promote);
        const content = draft.node(options.promote).content;
        if (content === undefined) throw new Error('Promotion source is not inline');
        const classification = classifyInlineInput(content);
        if (classification.kind === 'conversion') {
          try {
            compiler.interpret(options.promote, classification.plan);
          } catch (error) {
            if (!(error instanceof ConversionDeclined)) throw error;
            compiler = makeCompiler();
          }
        }
      }
      if (!compiler.effects.length && !compiler.allocations.length)
        return { status: 'unchanged', applied: false };
      const key = `${id.actor}:${id.sequence}`;
      const prepared = this.native.prepare(key, compiler.native.operations);
      let envelope: ActionEnvelope;
      try {
        envelope = compiler.bind(this.native, prepared.body);
      } catch (error) {
        prepared.abort();
        throw error;
      }
      const after = (
        publication: ReturnType<LocalEditor['refresh']>,
      ): StableSelection | undefined => {
        if (outcome.selection?.type === 'preserve-block-selection' && selectionBefore)
          return selectionBefore;
        if (!outcome.focus)
          return outcome.selection?.type === 'clear' ? undefined : selectionBefore;
        const target = compiler.focusTarget(
          outcome.focus.nodeId,
          outcome.focus.offset,
          outcome.focus.affinity,
        );
        const index = commandViewIndex(publication.value.view.root);
        const targetHandle = target.node && index.handleOrigin(target.node);
        const node = targetHandle ? index.origins.get(targetHandle) : undefined;
        if (!node) return undefined;
        const hostId =
          selectionBefore?.focus.host.representative ??
          (options.hostRoot
            ? draft.origins.get(options.hostRoot)?.origin.representative
            : undefined);
        const host = hostId
          ? (() => {
              const visit = (n: ViewNode): ViewNode | undefined =>
                n.origin.constituents.some((id) => resourceKey(id) === resourceKey(hostId))
                  ? n
                  : n.children.map(visit).find(Boolean);
              return visit(publication.value.view.root);
            })()
          : publication.value.view.root;
        if (!host) return undefined;
        const point = capturePoint(
          publication,
          node,
          Math.min(target.offset, node.content.length),
          outcome.focus.affinity,
          host,
        );
        return { anchor: point, focus: point };
      };
      // Capture against the exact author result before append. A later recovery
      // may include peer changes, so delayed numeric focus lowering is unsafe.
      let stagedAfter: StableSelection | undefined;
      let emptyAfter = false;
      let footprintForHistory;
      try {
        if (register) {
          const native = nativeView(this.native);
          const staged =
            this.document.stageLocalAction?.(envelope, native) ??
            (() => {
              const actions = [...ready, envelope];
              return {
                heads: [envelope.id],
                native,
                value: projectMarkdown({
                  genesis: this.genesis.layout,
                  genesisManifest: this.genesis.body.nativeManifest,
                  initialProperties: this.genesis.initialProperties,
                  ...reconstructProvenance(this.genesis.layout, actions),
                  native,
                }),
              };
            })();
          footprintForHistory = captureFootprint(envelope, p, native);
          stagedAfter = after(staged);
          emptyAfter =
            !!staged.value.view.emptyRoot &&
            (!options.hostRoot || options.hostRoot === draft.rootId);
        }
      } catch (error) {
        prepared.abort();
        throw error;
      }
      this.append(envelope, prepared, () => {
        retained = id;
        register?.({
          envelope: structuredClone(envelope),
          selectionBefore,
          selectionAfter: stagedAfter,
          footprint: footprintForHistory!,
          emptyBefore:
            !!p.value.view.emptyRoot && (!options.hostRoot || options.hostRoot === draft.rootId),
          emptyAfter,
        });
      });
      const publication = this.refresh();
      const selectionAfter = register ? stagedAfter : after(publication);
      const footprint = {
        allocations: structuredClone(envelope.allocations),
        effects: structuredClone(envelope.effects),
      };
      let focus: TextPoint | undefined;
      if (outcome.focus && register && stagedAfter) {
        // The exact author result was captured before append. Re-lowering its
        // numeric offset after a reentrant receive can shift the caret or split
        // a surrogate pair. Return the captured native neighbor instead.
        const { address, native, side } = stagedAfter.focus;
        focus = structuredClone({ address, native, side });
      } else if (outcome.focus) {
        const target = compiler.focusTarget(
          outcome.focus.nodeId,
          outcome.focus.offset,
          outcome.focus.affinity,
        );
        const resource = target.node;
        const find = (n: ViewNode): ViewNode | undefined =>
          resource && resourceKey(n.origin.representative) === resourceKey(resource)
            ? n
            : n.children.map(find).find(Boolean);
        const node = find(publication.value.view.root);
        if (node)
          focus = textPoint(
            node,
            Math.min(target.offset, node.content.length),
            outcome.focus.affinity,
          );
      }
      return {
        status: 'applied',
        applied: true,
        action: id,
        group: base.groupId,
        envelope,
        outcome,
        footprint,
        ...(focus ? { focus } : {}),
        ...(selectionBefore ? { selectionBefore } : {}),
        ...(selectionAfter ? { selectionAfter } : {}),
      };
    } catch (error) {
      if (retained) throw new RetainedEditError(retained, error);
      if (error instanceof ConversionDeclined)
        return {
          status: 'declined',
          applied: false,
          reason: error.reason,
          message: error.message,
        };
      throw error;
    } finally {
      this.editing = false;
    }
  }
  /** Complete reference replay synchronously; decode/capacity failures still propagate. */
  refresh() {
    return measure(
      'publication',
      () => {
        let result = this.document.publication.refresh();
        while (result.state === 'deferred') result = result.continuation.resume();
        return result.value;
      },
      'publication',
    );
  }
  editEmptyRoot(session: AuthorSession, text: string): LocalEditResult {
    if (this.sessions.has(session.local))
      throw new Error('Session is managed; use its history facade');
    this.unmanaged.add(session.local);
    return this.performEmptyRoot(session, text);
  }
  private performEmptyRoot(
    session: AuthorSession,
    text: string,
    register?: (edit: RetainedEdit) => void,
  ): LocalEditResult {
    const p = this.current();
    if (!p.value.view.emptyRoot) throw new Error('Document does not have an empty-root caret');
    requestEmptyRootEdit(p.value.view, text);
    return this.performEdit(
      session,
      ({ draft, scopeRoot }) => {
        const id = draft.create({ type: 'paragraph', content: text });
        draft.place(id, scopeRoot, null);
        return { status: 'handled', focus: draft.bookmark(id, text.length, 'right') };
      },
      undefined,
      {},
      register,
    );
  }
  destroy(): void {
    if (this.editing) throw new Error('Cannot close during a local edit');
    this.closed = true;
    this.synced = undefined;
    this.ahead.clear();
    this.applied.clear();
    this.native.destroy();
  }
}
