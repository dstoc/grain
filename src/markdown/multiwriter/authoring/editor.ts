import { decodeUpdate, Item } from 'yjs';
import { encodeEnvelope } from '../actions/codec.js';
import { compareBytes } from '../actions/cbor.js';
import { classifyInlineInput } from '../../block-parser/api.js';
import type { ParserConversionPlan } from '../../block-parser/types.js';
import type { Edit, EditOutcome } from '../../../editing/outcomes.js';
import type { EditSelection } from '../../semantic/selection.js';
import type { NodeId as Handle } from '../../semantic/types.js';
import { actorId, assertCounter } from '../contracts.js';
import type { ActionEnvelope, ActionId, GroupId, NodeId, ProjectionAddress } from '../contracts.js';
import type { ReferenceGenesis, openReferenceDocument } from '../reference/document.js';
import { resourceKey } from '../layout/index.js';
import { NativeTapeCache } from '../text/cache.js';
import { textPoint, requestEmptyRootEdit } from '../projection/addresses.js';
import type { TextPoint } from '../projection/addresses.js';
import type { ViewNode } from '../projection/types.js';
import { MultiwriterCommandDraft } from './draft.js';
import { CommandCompiler, ConversionDeclined } from './compiler.js';

export interface AuthorSession {
  readonly local: string;
  readonly group: bigint;
}
export interface StableSelection {
  readonly anchor: TextPoint;
  readonly focus: TextPoint;
  readonly blocks?: readonly ProjectionAddress[];
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
  readonly selectionBefore?: EditSelection;
  readonly conversion?: { readonly nodeId: Handle; readonly plan: ParserConversionPlan };
  readonly promote?: Handle;
}

/** Canonical facts were retained. Refresh and retry persistence; do not repeat this edit. */
export class RetainedEditError extends Error {
  readonly appended = true;
  constructor(
    readonly action: ActionId,
    cause: unknown,
  ) {
    super('Edit was appended; recover publication before the next command', { cause });
    this.name = 'RetainedEditError';
  }
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
  private native = new NativeTapeCache();
  private sequence = 0n;
  private editing = false;
  private closed = false;
  private applied = new Set<string>();
  constructor(
    readonly document: ReturnType<typeof openReferenceDocument>,
    private readonly genesis: ReferenceGenesis,
  ) {
    this.genesis = structuredClone(genesis);
    this.native.apply('genesis', this.genesis.body);
  }
  get nativeClientId(): number {
    return this.native.clientId;
  }
  /** Handles are local to the current projection and never enter an envelope. */
  handle(node: NodeId): Handle {
    const p = this.document.publication.status().publication;
    if (!p) throw new Error('Document has no publication');
    let ordinal = 0,
      found: Handle | undefined;
    const visit = (n: ViewNode) => {
      const handle = `construction:${ordinal++}`;
      if (resourceKey(n.origin.representative) === resourceKey(node)) found = handle;
      for (const child of n.children) visit(child);
    };
    visit(p.value.view.root);
    if (!found) throw new Error('Node is not in the current projection');
    return found;
  }
  private sync(ready: readonly ActionEnvelope[]) {
    const keys = new Set(ready.map((a) => `${a.id.actor}:${a.id.sequence}`));
    if ([...this.applied].some((k) => !keys.has(k))) {
      this.native.destroy();
      this.native = new NativeTapeCache();
      this.native.apply('genesis', this.genesis.body);
      this.applied.clear();
    }
    for (const a of ready) {
      const key = `${a.id.actor}:${a.id.sequence}`;
      if (!this.applied.has(key)) {
        this.native.apply(key, a);
        this.applied.add(key);
      }
    }
  }
  edit<Input>(
    session: AuthorSession,
    command: Edit<Input>,
    input: Input,
    options: LocalEditOptions = {},
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
        ready = this.document.store.snapshot().ready;
      this.sync(ready);
      const draft = new MultiwriterCommandDraft(p.value.view.root);
      const beforeSelection = options.selectionBefore;
      const stablePoint = (point: EditSelection['anchor']): TextPoint => {
        const node = draft.origins.get(point.nodeId);
        if (!node) throw new Error('Selection has no projected origin');
        return textPoint(node, point.offset, point.affinity);
      };
      const selectionBefore: StableSelection | undefined = beforeSelection
        ? {
            anchor: stablePoint(beforeSelection.anchor),
            focus: stablePoint(beforeSelection.focus),
            ...('nodeIds' in beforeSelection
              ? {
                  blocks: beforeSelection.nodeIds.map((id) => {
                    const node = draft.origins.get(id);
                    if (!node) throw new Error('Selected block has no projected origin');
                    return structuredClone(node.origin);
                  }),
                }
              : {}),
          }
        : undefined;
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
      const id = { actor: this.actor, sequence: this.sequence + 1n };
      assertCounter(id.sequence);
      const lamport = ready.reduce((max, a) => (a.lamport > max ? a.lamport : max), 0n) + 1n;
      assertCounter(lamport);
      const dependencies = [...p.heads];
      if (
        this.sequence > 0n &&
        !dependencies.some((d) => d.actor === this.actor && d.sequence === this.sequence)
      )
        dependencies.push({ actor: this.actor, sequence: this.sequence });
      const base = {
        protocolVersion: 3 as const,
        documentId: this.genesis.documentId,
        genesisId: this.genesis.genesisId,
        id,
        lamport,
        dependencies,
        groupId: { session: { actor: this.actor, local: session.local }, sequence: session.group },
      };
      const makeCompiler = () => {
        const c = new CommandCompiler(
          this.genesis,
          ready,
          base,
          draft,
          p.value.view.root,
          p.native,
        );
        c.run();
        return c;
      };
      let compiler = makeCompiler();
      if (options.conversion) {
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
      let appended = false;
      let envelope: ActionEnvelope | undefined;
      const retain = () => {
        prepared.commit();
        this.applied.add(key);
        this.sequence = id.sequence;
        retained = id;
      };
      try {
        envelope = compiler.bind(this.native, prepared.body);
        this.document.certifyLocal(envelope);
        this.document.store.append(envelope);
        appended = true;
      } catch (error) {
        // A synchronous update observer can throw after append has changed the
        // canonical store. Inspect the exact retained payload before aborting.
        if (envelope) {
          const bytes = encodeEnvelope(envelope);
          appended = decodeUpdate(this.document.store.encodeUpdate()).structs.some(
            (struct) =>
              struct instanceof Item &&
              struct.content
                .getContent()
                .some((value) => value instanceof Uint8Array && compareBytes(value, bytes) === 0),
          );
        }
        if (appended) retain();
        else prepared.abort();
        throw error;
      }
      retain();
      const publication = this.refresh();
      const footprint = {
        allocations: structuredClone(envelope.allocations),
        effects: structuredClone(envelope.effects),
      };
      let focus: TextPoint | undefined;
      if (outcome.focus) {
        const resource = compiler.resource(outcome.focus.nodeId);
        const find = (n: ViewNode): ViewNode | undefined =>
          resource && resourceKey(n.origin.representative) === resourceKey(resource)
            ? n
            : n.children.map(find).find(Boolean);
        const node = find(publication.value.view.root);
        if (node)
          focus = textPoint(
            node,
            Math.min(
              compiler.focusOffset(
                outcome.focus.nodeId,
                outcome.focus.offset,
                outcome.focus.affinity,
              ),
              node.content.length,
            ),
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
        ...(outcome.selection?.type === 'preserve-block-selection' && selectionBefore
          ? { selectionAfter: selectionBefore }
          : focus
            ? { selectionAfter: { anchor: focus, focus } }
            : {}),
      };
    } catch (error) {
      if (retained) throw new RetainedEditError(retained, error);
      throw error;
    } finally {
      this.editing = false;
    }
  }
  /** Complete reference replay synchronously; decode/capacity failures still propagate. */
  refresh() {
    let result = this.document.publication.refresh();
    while (result.state === 'deferred') result = result.continuation.resume();
    return result.value;
  }
  editEmptyRoot(session: AuthorSession, text: string): LocalEditResult {
    const p = this.document.publication.status().publication;
    if (!p?.value.view.emptyRoot) throw new Error('Document does not have an empty-root caret');
    requestEmptyRootEdit(p.value.view, text);
    return this.edit(
      session,
      ({ draft, scopeRoot }) => {
        const id = draft.create({ type: 'paragraph', content: text });
        draft.place(id, scopeRoot, null);
        return { status: 'handled', focus: draft.bookmark(id, text.length, 'right') };
      },
      undefined,
    );
  }
  destroy(): void {
    if (this.editing) throw new Error('Cannot close during a local edit');
    this.closed = true;
    this.native.destroy();
  }
}
