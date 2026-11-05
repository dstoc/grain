import * as Y from 'yjs';
// @ts-expect-error Node APIs are supplied by Vitest; Grain has no @types/node dependency.
import { Buffer } from 'node:buffer';
import { actorId, SYNC_DIRECTIONS } from '../../../src/markdown/multiwriter/contracts.js';
import type {
  ActionEnvelope,
  ActionId,
  NativeTextRange,
  ResourceId,
  ResourceKind,
  SyncMode,
} from '../../../src/markdown/multiwriter/contracts.js';
import {
  compareBytes,
  decodeCbor,
  encodeCbor,
} from '../../../src/markdown/multiwriter/actions/cbor.js';
import {
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeDecodeError,
} from '../../../src/markdown/multiwriter/actions/codec.js';
import { resourceKey } from '../../../src/markdown/multiwriter/layout/index.js';
import { NativeFixture } from '../../../src/markdown/multiwriter/ownership/test-fixtures.js';
import { NativeTapeCache } from '../../../src/markdown/multiwriter/text/cache.js';
import type { TapePart } from '../../../src/markdown/multiwriter/text/cache.js';
import { DirectionalActionProvider } from '../../../src/markdown/multiwriter/providers/adapter.js';
import { openReferenceDocument } from '../../../src/markdown/multiwriter/reference/document.js';
import type { ReferenceGenesis } from '../../../src/markdown/multiwriter/reference/document.js';
import type { AuthoringDocument } from '../../../src/markdown/multiwriter/authoring/document.js';
import type {
  ActionStore,
  ActionStoreSnapshot,
} from '../../../src/markdown/multiwriter/actions/store.js';
import { serializeProjection } from '../../../src/markdown/multiwriter/projection/index.js';
import type { ViewNode } from '../../../src/markdown/multiwriter/projection/index.js';
import type { ContractTrace, Observation, TraceAction } from '../trace.js';
import type { ReplicaFactory, ReplicaPort } from '../network.js';
import { get, prepareAction, role } from './author.js';
import type { Aliases } from './author.js';
import { selectCarrier } from './carrier.js';

const key = (id: ActionId) => `${id.actor}:${id.sequence}`;

/** Observations contain semantic data only; native bytes use isolationState().
 * Freeze one detached observation per facts version, so repeated readonly exports
 * do not copy its whole tree. The network still requests and checks a stable snapshot
 * on every read, and raw canonical/native isolation reads remain uncached.
 */
function freezeObservation(value: Observation): Observation {
  const pending: unknown[] = [value],
    seen = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    pending.push(...Object.values(item));
    Object.freeze(item);
  }
  return value;
}

/** Retain the actual immutable payloads rather than re-encoding every old
 * envelope for fixture-native prefix checks. Readiness guarantees one variant.
 */
function readyPayloads(snapshot: ActionStoreSnapshot): Uint8Array[] {
  const entries = new Map(snapshot.actions.map((entry) => [key(entry.id), entry]));
  return snapshot.ready.map((action) => {
    const entry = entries.get(key(action.id));
    if (entry?.variants.length !== 1) throw new Error('Ready action lacks one exact payload');
    return entry.variants[0];
  });
}

function lowerBoundIndex(entries: readonly { readonly index: number }[], position: number): number {
  let low = 0,
    high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].index < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface HeadlessDocument extends AuthoringDocument {
  readonly store: ActionStore;
  readonly publication: AuthoringDocument['publication'] & { evict?(): void };
  nativeStates(): readonly Uint8Array[];
  destroy(): void;
}
export interface ReferenceFactoryOptions {
  readonly openDocument?: (genesis: ReferenceGenesis) => HeadlessDocument;
  /** Observe each completed publication, including before final convergence. */
  readonly onPublication?: (document: HeadlessDocument, genesis: ReferenceGenesis) => void;
}

/** Immutable common genesis and trace command definitions only. Expected observations
 * are deliberately not captured. Every open owns all maps, clients and namespaces.
 */
export function referenceFactory(
  trace: ContractTrace,
  onAuthor?: (action: TraceAction) => void,
  options: ReferenceFactoryOptions = {},
): ReplicaFactory {
  const commands = structuredClone(
    trace.steps.flatMap((s) => (s.type === 'author' ? [s.action] : [])),
  );
  const seed = structuredClone(trace.seed);
  const peers = [...trace.peers];
  const f = new NativeFixture(seed);
  const genesis = structuredClone({
    documentId: 'D',
    genesisId: 'G',
    layout: f.genesis,
    body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
  });
  const seedAliases: Aliases = structuredClone({
    ids: f.ids,
    text: f.aliases,
    ranges: f.ranges,
    slots: f.slots,
  });
  f.destroy();
  const immutable = structuredClone({ commands, genesis, seedAliases });
  return {
    async open({ peer, checkpoint }): Promise<ReplicaPort> {
      const config = structuredClone(immutable);
      const commandByName = new Map(config.commands.map((c) => [c.id, c]));
      const actorAliases = new Map<string, { peer: string; first: bigint }>();
      const rank = peers.indexOf(peer as 'A' | 'B' | 'C');
      const writerActor = (() => {
        for (;;) {
          const bytes = crypto.getRandomValues(new Uint8Array(16));
          if (Math.floor(bytes[0] / (256 / 3)) === rank)
            return actorId(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
        }
      })();
      let writerSequence = 0n;
      let firstSymbolicSequence: bigint | undefined;
      function register(actor: string, session: string) {
        const match = /^reference:([ABC]):([1-9][0-9]*)$/.exec(session);
        if (!match) throw new Error('Unknown reference session alias');
        const prior = actorAliases.get(actor),
          value = { peer: match[1], first: BigInt(match[2]) };
        if (prior && (prior.peer !== value.peer || prior.first !== value.first))
          throw new Error('Conflicting reference session alias');
        actorAliases.set(actor, value);
      }
      // Symbolic aliases only: readiness/native/projection still use each actual
      // document's independent decoders and validators. The complete bytes key
      // distinguishes forks, malformed variants and envelope extras exactly.
      const decodedAliases = new Map<string, ActionEnvelope>();
      function decodeReference(bytes: Uint8Array) {
        const key = Buffer.from(bytes).toString('base64');
        const previous = decodedAliases.get(key);
        if (previous) return previous;
        const action = decodeEnvelope(bytes);
        register(action.id.actor, action.groupId.session.local);
        decodedAliases.set(key, action);
        return action;
      }

      const openDocument = options.openDocument ?? openReferenceDocument;
      let document: HeadlessDocument = openDocument(config.genesis);
      const journalBytes: Uint8Array[] = checkpoint ? [checkpoint.slice()] : [];
      let provider = await DirectionalActionProvider.open({
        store: document.store,
        mode: 'bidirectional',
        journal: {
          read: async () => journalBytes.map((b) => b.slice()),
          append: async (b) => {
            journalBytes.push(b.slice());
          },
          close() {},
        },
      });
      function freshNative() {
        const rank = peers.indexOf(peer as 'A' | 'B' | 'C');
        for (;;) {
          const cache = new NativeTapeCache();
          if (Math.floor(cache.clientId / (0x100000000 / 3)) === rank) return cache;
          cache.destroy();
        }
      }
      let native = freshNative();
      let readyBytes: Uint8Array[] = [];
      let aliases = structuredClone(config.seedAliases);
      const history = { undo: [] as string[], redo: [] as string[] };
      const peerVectors = new Map<string, Uint8Array>();
      let mode: SyncMode = 'bidirectional';
      const emitted: string[] = [];
      const envelopes = new Map<string, ActionEnvelope>();
      function name(id: ActionId) {
        const actor = actorAliases.get(id.actor);
        if (!actor) throw new Error('Unknown trace action identity');
        return `${actor.peer}${actor.first + id.sequence - 1n}`;
      }
      function envelope(n: string) {
        const value = envelopes.get(n);
        if (!value) throw new Error(`Unavailable action ${n}`);
        return value;
      }
      function alias(id: ResourceId<ResourceKind>) {
        return (
          [...aliases.ids].find(([, v]) => resourceKey(v) === resourceKey(id))?.[0] ??
          resourceKey(id)
        );
      }
      let materializedVersion = -1;
      let cached:
        | {
            snapshot: ReturnType<typeof document.store.snapshot>;
            p: NonNullable<ReturnType<typeof document.publication.status>['publication']>;
          }
        | undefined;
      function materialize() {
        if (cached && materializedVersion === document.store.factsVersion) return cached;
        const snapshot = document.store.snapshot();
        const bytes = readyPayloads(snapshot);
        if (
          readyBytes.length > bytes.length ||
          readyBytes.some((b, i) => compareBytes(b, bytes[i]) !== 0)
        ) {
          native.destroy();
          native = freshNative();
          readyBytes = [];
        }
        native.apply('G', config.genesis.body);
        for (let i = readyBytes.length; i < bytes.length; i++)
          native.apply(key(snapshot.ready[i].id), snapshot.ready[i]);
        readyBytes = bytes;
        envelopes.clear();
        for (const entry of snapshot.actions)
          for (const variant of entry.variants) {
            try {
              const decoded = decodeReference(variant);
              envelopes.set(name(entry.id), decoded);
            } catch {
              /* Invalid variants remain in canonical diagnostics, never author inputs. */
            }
          }
        aliases = structuredClone(config.seedAliases);
        // All ready bodies have been applied above. Alias reconstruction only reads
        // this native cache, so every insert on one tape sees the same snapshot.
        // Keep this local to one materialization, including fresh checkpoint opens.
        const tapeSnapshots = new Map<string, ReturnType<typeof native.snapshot>>();
        const markerParts = new Map<string, readonly Extract<TapePart, { type: 'marker' }>[]>();
        for (const action of snapshot.ready) {
          const command = commandByName.get(name(action.id));
          if (!command) throw new Error('No immutable alias definition');
          let textIndex = 0;
          const text = action.nativeManifest.filter((v) => v.type === 'text');
          for (const [i, intent] of command.intents.entries()) {
            const bind = (n: string, k: ResourceKind, offset: number) =>
              aliases.ids.set(n, role(action.id, i, offset, k));
            if (intent.type === 'split' || intent.type === 'create') {
              const b =
                intent.type === 'create'
                  ? intent.block
                  : {
                      id: intent.node,
                      flow: intent.flow,
                      run: intent.run,
                      tape: `t${intent.node}`,
                      cells: [],
                    };
              bind(b.id, 'node', 0);
              bind(`${b.id}:birth`, 'occurrence', 6);
              if (b.flow) {
                bind(b.flow, 'flow', 1);
                bind(b.run!, 'run', 2);
                bind(b.tape!, 'tape', 3);
                const tape = get(aliases, b.tape!, 'tape'),
                  run = get(aliases, b.run!, 'run');
                const start = role(action.id, i, 4, 'marker'),
                  end = role(action.id, i, 5, 'marker');
                aliases.slots.set(`${b.id}:home-end`, {
                  run,
                  boundary: end,
                  side: 'left',
                  predecessor: null,
                });
                aliases.slots.set(`${b.id}:start`, {
                  run,
                  boundary: start,
                  side: 'right',
                  predecessor: null,
                });
                aliases.slots.set(`${b.id}:end`, {
                  run,
                  boundary: end,
                  side: 'left',
                  predecessor: null,
                });
                let before = b.cells?.length ? role(action.id, i, 7, 'marker') : start;
                for (const [j, cell] of (b.cells ?? []).entries()) {
                  const after = role(action.id, i, 20 + j, 'marker');
                  aliases.ranges.set(cell.id, { tape, start: before, end: after });
                  aliases.slots.set(`${b.id}:after-${cell.text}`, {
                    run,
                    boundary: after,
                    side: 'right',
                    predecessor: null,
                  });
                  if (cell.text.length) {
                    const birth = text[textIndex++];
                    if (!birth) throw new Error('Missing authored cell text');
                    aliases.text.set(cell.id, { tape: birth.tape, ...birth.native });
                  }
                  before = after;
                }
                if (intent.type === 'split') {
                  const split = action.effects.find(
                    (e) =>
                      e.type === 'SplitFlow' &&
                      resourceKey(e.newNode) === resourceKey(get(aliases, b.id, 'node')),
                  )!;
                  if (split.type !== 'SplitFlow') throw new Error('Missing split');
                  bind(intent.marker, 'marker', 7);
                  const root = action.allocations.find(
                    (v) => v.type === 'run' && resourceKey(v.id) === resourceKey(split.newRun),
                  )!;
                  if (root.type !== 'run') throw new Error('Missing root');
                  const capture = root.skeleton.slice(0, -1);
                  if (capture.length) {
                    aliases.slots.set(`${b.id}:start`, {
                      run,
                      boundary: capture[0].start,
                      side: 'right',
                      predecessor: null,
                    });
                    aliases.slots.set(`${b.id}:end`, {
                      run,
                      boundary: capture.at(-1)!.end,
                      side: 'left',
                      predecessor: null,
                    });
                  }
                }
              }
            } else if (intent.type === 'insert') {
              const birth = text[textIndex++];
              if (!birth) throw new Error('Missing inserted text');
              aliases.text.set(intent.cell, { tape: birth.tape, ...birth.native });
              const tapeKey = resourceKey(birth.tape);
              let snap = tapeSnapshots.get(tapeKey);
              if (!snap) {
                snap = native.snapshot(birth.tape);
                tapeSnapshots.set(tapeKey, snap);
                markerParts.set(
                  tapeKey,
                  snap.parts.filter((part) => part.type === 'marker'),
                );
              }
              const at = native.locate(birth.tape, birth.native);
              const markers = markerParts.get(tapeKey)!;
              const left = markers[lowerBoundIndex(markers, at) - 1];
              const right = markers[lowerBoundIndex(markers, at + birth.native.length)];
              if (left.type === 'marker' && right.type === 'marker')
                aliases.ranges.set(intent.cell, {
                  tape: birth.tape,
                  start: left.marker,
                  end: right.marker,
                });
            } else if (intent.type === 'transfer') bind(intent.run, 'run', 2);
            else if (intent.type === 'interpret' || intent.type === 'parse')
              bind(intent.packet, 'interpretation', 0);
            else if (intent.type === 'delete-subtree' || intent.type === 'delete-text')
              bind(intent.tag, 'deletion', 0);
          }
        }
        let publication = document.publication.refresh();
        while (publication.state === 'deferred')
          publication = publication.continuation.resume(Number.MAX_SAFE_INTEGER);
        options.onPublication?.(document, config.genesis);
        materializedVersion = document.store.factsVersion;
        cached = { snapshot, p: publication.value };
        return cached;
      }
      function inventory() {
        const variants = new Map<string, Uint8Array[]>();
        for (const item of Y.decodeUpdate(document.store.encodeUpdate()).structs) {
          if (!(item instanceof Y.Item)) continue;
          for (const bytes of item.content.getContent()) {
            if (!(bytes instanceof Uint8Array)) throw new Error('Invalid canonical payload');
            let id: ActionId;
            try {
              id = decodeReference(bytes).id;
            } catch (error) {
              if (!(error instanceof EnvelopeDecodeError) || !error.id) throw error;
              id = error.id;
              const wire = decodeCbor(bytes) as { groupId: { session: { local: string } } };
              register(id.actor, wire.groupId.session.local);
            }
            const n = name(id),
              held = variants.get(n) ?? [];
            if (!held.some((v) => compareBytes(v, bytes) === 0)) held.push(bytes);
            variants.set(n, held);
          }
        }
        const names = [...variants.keys()].sort((a, b) => {
          const x = commandByName.get(a)!,
            y = commandByName.get(b)!;
          return x.lamport < y.lamport
            ? -1
            : x.lamport > y.lamport
              ? 1
              : a < b
                ? -1
                : a > b
                  ? 1
                  : 0;
        });
        return { names, variants };
      }
      let observedVersion = -1;
      let observed: Observation | undefined;
      function observe(): Observation {
        if (observed && observedVersion === document.store.factsVersion)
          return Object.freeze({
            ...observed,
            undo: Object.freeze([...history.undo]),
            redo: Object.freeze([...history.redo]),
            emittedActions: Object.freeze([...emitted]),
          });
        const { snapshot, p } = materialize();
        const beforeCanonical = document.store.encodeUpdate(),
          beforeNative = native.encodeState();
        const held = inventory();
        const stateByName = new Map(snapshot.actions.map((v) => [name(v.id), v.readiness.state]));
        const o = p.value.ownership;
        const textEntries = [...aliases.text];
        // Symbolic lookup only. Keep the original first-match rule for overlapping
        // aliases; disjoint native ranges can use a clock index instead of rescanning
        // every alias for every visible fragment at every observation.
        const aliasIndex = new Map<string, { start: number; end: number; name: string }[]>();
        for (const [name, range] of textEntries) {
          const key = `${resourceKey(range.tape)}:${range.client}`;
          const entries = aliasIndex.get(key) ?? [];
          entries.push({ start: range.clock, end: range.clock + range.length, name });
          aliasIndex.set(key, entries);
        }
        const overlapping = new Set<string>();
        for (const [key, entries] of aliasIndex) {
          entries.sort((a, b) => a.start - b.start);
          if (entries.some((entry, i) => i > 0 && entries[i - 1].end > entry.start))
            overlapping.add(key);
        }
        const tokenAlias = (range: NativeTextRange) => {
          const key = `${resourceKey(range.tape)}:${range.client}`;
          if (overlapping.has(key))
            return textEntries.find(
              ([, value]) =>
                resourceKey(value.tape) === resourceKey(range.tape) &&
                value.client === range.client &&
                value.clock <= range.clock &&
                range.clock < value.clock + value.length,
            )?.[0];
          const entries = aliasIndex.get(key);
          if (!entries) return undefined;
          let low = 0,
            high = entries.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (entries[middle].start <= range.clock) low = middle + 1;
            else high = middle;
          }
          const entry = entries[low - 1];
          return entry && range.clock < entry.end ? entry.name : undefined;
        };
        const visible: Record<string, string[]> = {};
        const view: Observation['view'][number][] = [];
        const addresses: Record<string, Observation['addresses'][string]> = {};
        function visit(node: ViewNode, parent: string) {
          const n = alias(node.origin.representative);
          view.push({ id: n, parent, kind: node.type });
          if (['paragraph', 'section', 'code-block'].includes(node.type)) {
            visible[n] = [];
            for (const fragment of node.fragments)
              if (fragment.visible) {
                const id = tokenAlias(fragment.range);
                if (!id) throw new Error('Visible fragment without native alias');
                if (!visible[n].includes(id)) visible[n].push(id);
              }
          }
          if (node.origin.constituents.length > 1)
            addresses[n] = {
              type: 'group',
              representative: n,
              constituents: node.origin.constituents.map(alias),
            };
          for (const child of node.children) visit(child, n);
        }
        for (const child of p.value.view.root.children) visit(child, 'root');
        if (p.value.view.emptyRoot)
          addresses.caret = {
            type: 'empty-root',
            parent: alias(p.value.view.emptyRoot.slot.parent),
            predecessor: p.value.view.emptyRoot.slot.predecessor
              ? alias(p.value.view.emptyRoot.slot.predecessor)
              : null,
          };
        const visibleIds = new Set(Object.values(visible).flat());
        const slots: Record<string, string> = {};
        for (const [n, s] of aliases.slots) {
          if (n.endsWith(':start') || n.endsWith(':end')) {
            const node = n.slice(0, n.lastIndexOf(':'));
            if (
              config.genesis.layout.allocations.some(
                (v) => v.type === 'node' && alias(v.id) === node,
              )
            )
              slots[n] = alias(s.run);
          } else if (n === 'P:after-b' || n === 'P:after-c') slots[n] = alias(s.run);
        }
        // Named fixture slots are projections of actual retained origins. Expose wrapper
        // child starts when grouping needs a constituent-specific edit address.
        for (const node of view)
          if (
            node.parent &&
            node.parent !== 'root' &&
            addresses[node.parent]?.type === 'group' &&
            p.value.ownership.blockPlacement(get(aliases, node.id, 'node'))?.slot.parent &&
            alias(p.value.ownership.blockPlacement(get(aliases, node.id, 'node'))!.slot.parent) !==
              node.parent
          ) {
            const s = aliases.slots.get(`${node.id}:start`);
            if (s)
              addresses[`${node.id}:start`] = {
                type: 'slot',
                run: alias(s.run),
                slot: `${node.id}:start`,
              };
          }
        const nativeIds: Observation['nativeIds'] = Object.fromEntries(
          textEntries.map(([n, r]) => [n, { client: r.client, clock: r.clock, length: r.length }]),
        );
        const cellRuns: Record<string, string> = {};
        const nativeText: Record<string, string> = {};
        for (const [n, r] of textEntries) {
          cellRuns[n] = alias(o.owner({ tape: r.tape, native: r }).run);
          nativeText[n] = native
            .lookup(r)
            .map((v) => v.text)
            .join('');
        }
        const skeletons: Record<string, string[]> = {};
        for (const run of o.runLayouts)
          skeletons[alias(run.run)] = textEntries
            .map(([name, range]) => ({
              name,
              range,
              index: run.skeleton.findIndex((s) =>
                o.contains(s, { tape: range.tape, native: range }),
              ),
            }))
            .filter((entry) => entry.index >= 0)
            .map((entry) => ({ ...entry, position: native.locate(entry.range.tape, entry.range) }))
            .sort((a, b) => {
              return a.index - b.index || a.position - b.position;
            })
            .map((entry) => entry.name);
        // The symbolic skeleton facet is sparse text-alias coverage. Full native
        // marker/home skeletons are checked independently by reconstruction controls.
        for (const run of Object.keys(skeletons)) if (!skeletons[run].length) delete skeletons[run];
        for (const [n, range] of aliases.ranges)
          if (!aliases.text.has(n)) {
            const cells = o.cells(range);
            if (cells.length === 1) {
              cellRuns[n] = alias(cells[0].run);
              nativeText[n] = '';
            }
          }
        const splits = snapshot.ready.flatMap((action) =>
          action.effects.flatMap((effect) => (effect.type === 'SplitFlow' ? [effect] : [])),
        );
        for (const split of splits) {
          if (
            split.retainedSide === 'right' &&
            !textEntries.some(([, r]) =>
              o.inlineOwner(r).some((n) => resourceKey(n) === resourceKey(split.newNode)),
            )
          )
            slots[`${alias(split.newNode)}:empty`] = alias(split.newRun);
        }
        const cuts = splits
          .map((split) => ({ split, marker: native.marker(split.cut.boundary) }))
          .sort((a, b) => a.marker.index - b.marker.index);
        for (let i = 1; i < cuts.length; i++) {
          const left = cuts[i - 1],
            right = cuts[i];
          if (
            resourceKey(left.marker.tape) !== resourceKey(right.marker.tape) ||
            right.marker.index - left.marker.index !== 1
          )
            continue;
          const range = {
            tape: left.marker.tape,
            start: left.split.cut.boundary,
            end: right.split.cut.boundary,
          };
          const assignment = o.cells(range)[0];
          if (native.range(range).length || !assignment) continue;
          cellRuns['between-cuts'] = alias(assignment.run);
          nativeText['between-cuts'] = '';
          slots['between-cuts'] = alias(assignment.run);
          slots[`${alias(left.split.newNode)}:end`] = alias(left.split.newRun);
          slots[`${alias(right.split.newNode)}:start`] = alias(right.split.newRun);
        }
        observed = {
          raw: {
            visibility: p.value.visibility,
            projection: p.value.view,
            packets: p.value.interpretations.packets,
            children: o.nodeAllocations.map((node) => ({
              node: node.id,
              children: o.children(node.id),
            })),
            blocks: o.nodeAllocations.map((node) => ({
              node: node.id,
              placement: o.blockPlacement(node.id),
            })),
            flows: o.flowPlacements,
            runs: o.runLayouts,
            cells: o.assignments,
            homes: o.homeBindings,
            traversals: o.flowPlacements.map((flow) => ({
              flow: flow.flow,
              entries: o.raw(flow.flow),
            })),
          },
          nativeIds,
          resources: Object.fromEntries(
            [...aliases.ids].filter(([, id]) => ['node', 'flow', 'run'].includes(id.kind)),
          ),
          held: held.names,
          ready: snapshot.ready.map((v) => name(v.id)),
          pending: held.names.filter(
            (n) => !stateByName.has(n) || stateByName.get(n) === 'pending',
          ),
          quarantined: held.names.filter((n) => stateByName.get(n) === 'quarantined'),
          variants: Object.fromEntries(held.names.map((n) => [n, held.variants.get(n)!.length])),
          heads: snapshot.heads.map(name),
          rawParents: Object.fromEntries(
            o.nodeAllocations.map((n) => [
              alias(n.id),
              o.blockPlacement(n.id) ? alias(o.blockPlacement(n.id)!.slot.parent) : null,
            ]),
          ),
          flowParents: Object.fromEntries(
            o.flowPlacements.map((f) => [
              alias(f.flow),
              f.parent.type === 'block'
                ? `block:${alias(f.parent.node)}`
                : `flow:${alias(o.runLayouts.find((r) => resourceKey(r.run) === resourceKey(f.parent.type === 'flow' ? f.parent.slot.run : f.flow))!.flow)}@${[...aliases.slots].find(([, s]) => resourceKey(s.run) === resourceKey(f.parent.type === 'flow' ? f.parent.slot.run : f.flow) && resourceKey(s.boundary) === resourceKey(f.parent.type === 'flow' ? f.parent.slot.boundary : f.flow) && s.side === (f.parent.type === 'flow' ? f.parent.slot.side : ''))?.[0]}`,
            ]),
          ),
          runFlows: Object.fromEntries(o.runLayouts.map((r) => [alias(r.run), alias(r.flow)])),
          cellRuns,
          nativeText,
          skeletons,
          slots,
          visible,
          hidden: textEntries.filter(([n]) => !visibleIds.has(n)).map(([n]) => n),
          deletedNodes: p.value.visibility.nodes.filter((n) => n.deleted).map((n) => alias(n.node)),
          view,
          addresses,
          undo: [...history.undo],
          redo: [...history.redo],
          retainedActions: held.names,
          genesis: 'G',
          emittedActions: [...emitted],
          activePackets: p.value.interpretations.packets.map((v) => alias(v.id)),
          markdown: serializeProjection(p.value.view),
        };
        if (
          compareBytes(beforeCanonical, document.store.encodeUpdate()) ||
          compareBytes(beforeNative, native.encodeState())
        )
          throw new Error('Reference reads authored shared facts');
        observedVersion = document.store.factsVersion;
        observed = freezeObservation(structuredClone(observed));
        return observed;
      }
      return {
        get handles() {
          return {
            actionStore: document.store,
            textCache: native,
            reducer: document.publication,
            history,
          };
        },
        defineCommand(command) {
          const previous = commandByName.get(command.id);
          const json = (value: TraceAction) =>
            JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
          if (previous && json(previous) !== json(command))
            throw new Error('Conflicting test command definition');
          commandByName.set(command.id, structuredClone(command));
        },
        async author(command) {
          materialize();
          const expected = commandByName.get(command.id);
          if (!expected || expected.peer !== peer)
            throw new Error('Command is outside immutable trace plan');
          const control = command.intents.find((i) => i.type === 'control');
          if (
            control?.type === 'control' &&
            !(control.active ? history.redo : history.undo).includes(control.group)
          )
            throw new Error('Control does not belong to this live navigation');
          firstSymbolicSequence ??= command.sequence;
          if (command.sequence !== firstSymbolicSequence + writerSequence)
            throw new Error('Noncontiguous local reference command');
          const id = { actor: writerActor, sequence: writerSequence + 1n };
          const prepared = prepareAction({
            command,
            id,
            session: `reference:${peer}:${firstSymbolicSequence}`,
            document,
            native,
            aliases: structuredClone(aliases),
            envelope,
          });
          try {
            document.certifyLocal(prepared.envelope);
            document.store.append(prepared.envelope);
            const accepted = document.store.snapshot();
            if (!accepted.ready.some((v) => key(v.id) === key(id)))
              throw new Error(
                `Local action refused: ${command.id} ${JSON.stringify(accepted.actions.map((v) => v.readiness))}`,
              );
            prepared.commit();
            writerSequence++;
            readyBytes = readyPayloads(accepted);
          } catch (error) {
            prepared.abort();
            native.destroy();
            native = freshNative();
            readyBytes = [];
            materializedVersion = -1;
            observedVersion = -1;
            throw error;
          }
          if (control?.type === 'control') {
            const from = control.active ? history.redo : history.undo,
              to = control.active ? history.undo : history.redo;
            const at = from.indexOf(control.group);
            if (at < 0) throw new Error('Control does not belong to this live navigation');
            from.splice(at, 1);
            to.push(control.group);
          } else {
            if (!history.undo.includes(command.group)) history.undo.push(command.group);
            history.redo = [];
            if (history.undo.length > 500) history.undo.shift();
          }
          materialize();
          onAuthor?.(structuredClone(command));
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        },
        setMode(next) {
          mode = next;
          provider.setMode(next);
        },
        exportUpdate(names, mutation, recipient) {
          if (!SYNC_DIRECTIONS[mode].send) return Uint8Array.of(0, 0);
          const held = inventory();
          if (mutation) {
            const action = envelope(mutation.action);
            let bytes: Uint8Array;
            if (mutation.type === 'unsupported-version') {
              const wire = decodeCbor(encodeEnvelope(action));
              if (
                !wire ||
                typeof wire !== 'object' ||
                Array.isArray(wire) ||
                wire instanceof Uint8Array
              )
                throw new Error('Bad wire');
              bytes = encodeCbor({ ...wire, protocolVersion: 4n });
            } else if (mutation.type === 'fork-payload')
              bytes = encodeEnvelope({
                ...action,
                groupId: { ...action.groupId, sequence: action.groupId.sequence + 10000n },
              });
            else if (mutation.type === 'unknown-resource')
              bytes = encodeEnvelope({
                ...action,
                effects: [
                  ...action.effects,
                  {
                    type: 'SetProperties',
                    node: {
                      kind: 'node',
                      birth: { type: 'genesis', genesisId: 'G' },
                      ordinal: 999999,
                    },
                    values: { marker: 'bad' },
                  },
                ],
              });
            else {
              const doc = new Y.Doc({ gc: false });
              const updates: Uint8Array[] = [];
              doc.on('update', (u: Uint8Array) => updates.push(u));
              doc.getText('invalid').insert(0, 'x');
              updates.length = 0;
              doc.getText('invalid').delete(0, 1);
              bytes = encodeEnvelope({
                ...action,
                nativeInsertUpdates: [...action.nativeInsertUpdates, ...updates],
              });
              doc.destroy();
            }
            const doc = new Y.Doc({ gc: false });
            doc.getArray<Uint8Array>('envelopes').push([bytes]);
            const update = Y.encodeStateAsUpdate(doc);
            doc.destroy();
            return update;
          }
          if (names.length === held.names.length && held.names.every((n) => names.includes(n)))
            return document.store.encodeUpdate(recipient ? peerVectors.get(recipient) : undefined);
          const variants = names.flatMap((n) => held.variants.get(n) ?? []);
          return selectCarrier(document.store.encodeUpdate(), (bytes) =>
            variants.some((v) => compareBytes(v, bytes) === 0),
          );
        },
        receive(update, route) {
          provider.receive(route, update);
        },
        control() {
          return document.store.encodeStateVector();
        },
        receiveControl(update, from) {
          if (!from) throw new Error('State-vector feedback needs its peer identity');
          Y.decodeStateVector(update);
          peerVectors.set(from, update.slice());
        },
        observe,
        isolationState() {
          materialize();
          const diagnostic = new Y.Doc({ gc: false });
          for (const update of [native.encodeState(), ...document.nativeStates()])
            Y.applyUpdate(diagnostic, update);
          const bytes = Y.encodeStateAsUpdate(diagnostic);
          diagnostic.destroy();
          return { canonical: document.store.encodeUpdate(), native: bytes };
        },
        async checkpoint() {
          await provider.flush();
          return document.store.encodeUpdate();
        },
        async maintain(operation) {
          if (operation === 'evict-history') {
            history.undo = [];
            history.redo = [];
            return;
          }
          if (operation === 'drop-caches') {
            document.publication.evict?.();
            native.destroy();
            native = freshNative();
            readyBytes = [];
            materializedVersion = -1;
            observedVersion = -1;
            observedVersion = -1;
            materialize();
            return;
          }
          const bytes = document.store.encodeUpdate();
          await provider.close();
          document.destroy();
          document = openDocument(config.genesis);
          provider = await DirectionalActionProvider.open({
            store: document.store,
            mode,
            journal: { read: async () => [bytes], append: async () => {}, close() {} },
          });
          native.destroy();
          native = freshNative();
          readyBytes = [];
          materializedVersion = -1;
          observedVersion = -1;
          materialize();
        },
        async dispose() {
          await provider.close();
          native.destroy();
          document.destroy();
        },
      };
    },
  };
}
