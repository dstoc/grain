import { decodeUpdate, Item, mergeUpdates } from 'yjs';
import { SYNC_DIRECTIONS } from '../../src/markdown/multiwriter/contracts.js';
import type { DeliveryRoute, SyncMode } from '../../src/markdown/multiwriter/contracts.js';
import type { ContractTrace, Observation, Step, TraceAction, TraceAdapter } from './trace.js';

export type LocalStep = Exclude<Step, { type: 'deliver' | 'expect' }>;
type Mutation = Extract<Step, { type: 'deliver' }>['mutation'];
export type NetworkStep =
  | LocalStep
  | {
      readonly type: 'link';
      readonly from: string;
      readonly to: string;
      readonly enabled: boolean;
      readonly reverseControl: boolean;
    }
  | {
      readonly type: 'send';
      readonly id: string;
      readonly from: string;
      readonly to: string;
      readonly actions: readonly string[];
      readonly route: DeliveryRoute;
      readonly mutation?: Mutation;
    }
  | { readonly type: 'duplicate'; readonly id: string; readonly source: string }
  | { readonly type: 'merge'; readonly id: string; readonly sources: readonly string[] }
  | { readonly type: 'drop' | 'deliver' | 'ack'; readonly id: string }
  | { readonly type: 'replay'; readonly peer: string }
  | Extract<Step, { type: 'expect' }>;

/** Test schedule, not an envelope codec. Captured bytes belong to the real adapter. */
export interface NetworkTrace {
  readonly version: 1;
  readonly seed: number;
  readonly contract: ContractTrace;
  readonly steps: readonly NetworkStep[];
}
export type Equal = (actual: unknown, expected: unknown, context: string) => void;

/** Owners supply actual handles, not facade tokens, so accidental sharing fails early. */
export interface ReplicaHandles {
  readonly actionStore: object;
  readonly textCache: object;
  readonly reducer: object;
  readonly history: object;
}
export interface ReplicaStateBytes {
  /** Complete encodeStateAsUpdate(actionDoc), preserving outer native structs and payloads. */
  readonly canonical: Uint8Array;
  readonly native: Uint8Array;
}
export interface ReplicaPort {
  readonly handles: ReplicaHandles;
  /** Detached test command metadata for symbolic observation aliases only. It cannot
   * admit facts, supply native identities, or participate in certification.
   */
  defineCommand?(action: TraceAction): void;
  author(action: TraceAction): void | Promise<void>;
  setMode(mode: SyncMode): void | Promise<void>;
  /** Export complete envelopes as real transport bytes; subsets can omit semantic prerequisites.
   * Full held-set export must bootstrap a new receiver, including other actors' records.
   */
  exportUpdate(
    actions: readonly string[],
    mutation?: Mutation,
    recipient?: string,
  ): Uint8Array | Promise<Uint8Array>;
  /** Receive gating belongs here, before canonical ingestion, on every route. */
  receive(update: Uint8Array, route: DeliveryRoute): void | Promise<void>;
  control(): Uint8Array | Promise<Uint8Array>;
  receiveControl(update: Uint8Array, from?: string): void | Promise<void>;
  observe(): Observation | Promise<Observation>;
  /** Complete retained Yjs state, including pending outer structs and unprojected data.
   * Transport control metadata is separate. Reads must not author native operations.
   */
  isolationState(): ReplicaStateBytes | Promise<ReplicaStateBytes>;
  /** Lossless canonical state only. Opening it resets interactive navigation. */
  checkpoint(): Uint8Array | Promise<Uint8Array>;
  maintain(operation: Extract<Step, { type: 'maintain' }>['operation']): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface ReplicaFactory {
  /** No expected observations are passed to the implementation. Each call owns fresh state.
   * A checkpoint preserves native/action-store identities; new authors use a fresh instance.
   */
  open(input: {
    readonly peer: string;
    readonly genesis: Pick<ContractTrace, 'version' | 'genesis' | 'seed' | 'peers'>;
    readonly checkpoint?: Uint8Array;
  }): ReplicaPort | Promise<ReplicaPort>;
}
interface Message {
  readonly from: string;
  readonly to: string;
  readonly route: DeliveryRoute;
  readonly bytes: Uint8Array;
  state: 'queued' | 'delivered' | 'dropped';
}

const localFacets = new Set<keyof Observation>(['undo', 'redo', 'emittedActions']);
/** Counts do not identify immutable facts: one peer may hold a valid variant while
 * another holds a malformed variant of the same action. Include pending carrier
 * payloads, deduplicate identical envelopes and ignore outer transport identities.
 */
function canonicalPayloads(update: Uint8Array): readonly string[] {
  const values = new Set<string>();
  for (const item of decodeUpdate(update).structs) {
    if (!(item instanceof Item)) continue;
    for (const value of item.content.getContent()) {
      if (!(value instanceof Uint8Array)) throw new Error('Canonical carrier payload is not bytes');
      values.add(Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
  }
  return [...values].sort();
}
/** Compare every document facet, including hidden facts and origin bindings. */
export function compareDocument(
  actual: Observation,
  expected: Observation,
  equal: Equal,
  context: string,
): void {
  for (const key of Object.keys(expected) as (keyof Observation)[])
    if (!localFacets.has(key)) equal(actual[key], expected[key], `${context}.${key}`);
}

/** Deterministic PRNG with no clock, global Math.random, or platform-dependent sorting. */
export class SeededRandom {
  private state: number;
  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)
      throw new Error('Seed must be uint32');
    this.state = seed;
  }
  next(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 0x1_0000_0000)
      throw new Error('Invalid random limit');
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return Math.floor((((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000) * limit);
  }
}

/** Owns network state only. No shared semantic writer, reducer, or expected-state engine. */
export class ReplicaNetwork {
  private readonly replicas = new Map<string, ReplicaPort>();
  private readonly modes = new Map<string, SyncMode>();
  private readonly links = new Map<string, { enabled: boolean; reverseControl: boolean }>();
  private readonly messages = new Map<string, Message>();
  private readonly actions = new Map<string, TraceAction>();
  private readonly bindings = new Map<string, unknown>();
  private readonly inventories = new Map<string, Pick<Observation, 'held' | 'variants'>>();
  private readonly steps: NetworkStep[] = [];
  private readonly random: SeededRandom;
  private serial = 0;
  private constructor(
    private readonly factory: ReplicaFactory,
    private readonly contract: ContractTrace,
    private readonly equal: Equal,
    readonly seed: number,
  ) {
    this.random = new SeededRandom(seed);
  }
  static async open(
    factory: ReplicaFactory,
    contract: ContractTrace,
    equal: Equal,
    seed = 0,
  ): Promise<ReplicaNetwork> {
    const network = new ReplicaNetwork(factory, contract, equal, seed);
    try {
      for (const peer of contract.peers) {
        network.replicas.set(peer, await network.openPeer(peer));
        network.modes.set(peer, 'bidirectional');
      }
      network.assertIsolation();
      await network.inspect('genesis');
      return network;
    } catch (error) {
      await network.dispose();
      throw error;
    }
  }
  private async openPeer(peer: string, checkpoint?: Uint8Array): Promise<ReplicaPort> {
    const { version, genesis, seed, peers } = this.contract;
    const port = await this.factory.open({
      peer,
      genesis: structuredClone({ version, genesis, seed, peers }),
      checkpoint: checkpoint?.slice(),
    });
    for (const action of this.actions.values()) port.defineCommand?.(structuredClone(action));
    return port;
  }
  private peer(peer: string): ReplicaPort {
    const replica = this.replicas.get(peer);
    if (!replica) throw new Error(`Unknown peer ${peer}`);
    return replica;
  }
  private message(id: string): Message {
    const message = this.messages.get(id);
    if (!message) throw new Error(`Unknown message ${id}`);
    return message;
  }
  private link(from: string, to: string): string {
    this.peer(from);
    this.peer(to);
    return `${from}:${to}`;
  }
  private assertIsolation(extra?: ReplicaPort): void {
    const handles = [...this.replicas.values(), ...(extra ? [extra] : [])].flatMap((port) =>
      Object.values(port.handles),
    );
    this.equal(
      new Set(handles).size,
      handles.length,
      'replicas own separate action store, text cache, reducer and history',
    );
  }
  trace(): NetworkTrace {
    return structuredClone({
      version: 1,
      seed: this.seed,
      contract: this.contract,
      steps: this.steps,
    });
  }
  async observe(peer: string): Promise<Observation> {
    return structuredClone(await this.peer(peer).observe());
  }
  async step(step: NetworkStep): Promise<void> {
    // Record before execution so a failing command is included in the replay artifact.
    this.steps.push(structuredClone(step));
    const before = new Map<string, Observation>();
    const retained = new Map<string, ReplicaStateBytes>();
    for (const peer of this.contract.peers) {
      before.set(peer, await this.observe(peer));
      retained.set(peer, structuredClone(await this.peer(peer).isolationState()));
    }
    let changed: string | undefined;
    switch (step.type) {
      case 'author': {
        const action = step.action;
        if (this.actions.has(action.id)) throw new Error(`Duplicate author action ${action.id}`);
        this.validateAuthor(action, before.get(action.peer)!);
        this.actions.set(action.id, structuredClone(action));
        for (const replica of this.replicas.values())
          replica.defineCommand?.(structuredClone(action));
        await this.peer(action.peer).author(structuredClone(action));
        changed = action.peer;
        break;
      }
      case 'mode':
        await this.peer(step.peer).setMode(step.mode);
        this.modes.set(step.peer, step.mode);
        break;
      case 'link':
        this.links.set(this.link(step.from, step.to), {
          enabled: step.enabled,
          reverseControl: step.reverseControl,
        });
        break;
      case 'send': {
        if (this.messages.has(step.id)) throw new Error(`Duplicate message ${step.id}`);
        this.link(step.from, step.to);
        if (!SYNC_DIRECTIONS[this.modes.get(step.from)!].send) break;
        const held = before.get(step.from)!.held;
        for (const id of step.actions)
          this.equal(held.includes(id), true, `${step.from} exports held ${id}`);
        const bytes = await this.peer(step.from).exportUpdate(step.actions, step.mutation, step.to);
        this.messages.set(step.id, {
          from: step.from,
          to: step.to,
          route: step.route,
          bytes: bytes.slice(),
          state: 'queued',
        });
        break;
      }
      case 'duplicate': {
        if (this.messages.has(step.id)) throw new Error(`Duplicate message ${step.id}`);
        const source = this.message(step.source);
        this.messages.set(step.id, { ...source, bytes: source.bytes.slice(), state: 'queued' });
        break;
      }
      case 'merge': {
        if (this.messages.has(step.id)) throw new Error(`Duplicate message ${step.id}`);
        if (!step.sources.length) throw new Error('Cannot merge no messages');
        const sources = step.sources.map((id) => this.message(id));
        const first = sources[0];
        for (const source of sources)
          if (source.from !== first.from || source.to !== first.to || source.route !== first.route)
            throw new Error('Merged messages must share endpoints and route');
        this.messages.set(step.id, {
          ...first,
          bytes: mergeUpdates(sources.map((source) => source.bytes)),
          state: 'queued',
        });
        break;
      }
      case 'drop':
        this.message(step.id).state = 'dropped';
        break;
      case 'deliver': {
        const message = this.message(step.id);
        if (message.state !== 'queued') throw new Error(`Message ${step.id} is ${message.state}`);
        if (!this.links.get(this.link(message.from, message.to))?.enabled) break;
        // Previously sent messages can arrive after the sender disables sending.
        await this.peer(message.to).receive(message.bytes.slice(), message.route);
        message.state = 'delivered';
        if (SYNC_DIRECTIONS[this.modes.get(message.to)!].receive) changed = message.to;
        const after = await this.observe(message.to);
        for (const key of localFacets)
          this.equal(
            after[key],
            before.get(message.to)![key],
            `${message.to} remote delivery preserves local ${key}`,
          );
        break;
      }
      case 'ack': {
        const message = this.message(step.id);
        if (message.state !== 'delivered')
          throw new Error('Cannot acknowledge an undelivered message');
        if (!this.links.get(this.link(message.from, message.to))?.reverseControl)
          throw new Error('Reverse control traffic disabled');
        await this.peer(message.from).receiveControl(
          (await this.peer(message.to).control()).slice(),
          message.to,
        );
        break;
      }
      case 'restart': {
        const prior = this.peer(step.peer);
        const replacement = await this.openPeer(step.peer, await prior.checkpoint());
        try {
          this.assertIsolation(replacement);
          await replacement.setMode(this.modes.get(step.peer)!);
          const restored = await replacement.observe();
          compareDocument(restored, before.get(step.peer)!, this.equal, `${step.peer} restart`);
          this.equal(
            (await replacement.isolationState()).canonical,
            retained.get(step.peer)!.canonical,
            `${step.peer} restart preserves canonical native state`,
          );
          this.equal(restored.undo, [], `${step.peer} restart resets undo navigation`);
          this.equal(restored.redo, [], `${step.peer} restart resets redo navigation`);
        } catch (error) {
          await replacement.dispose();
          throw error;
        }
        this.replicas.set(step.peer, replacement);
        await prior.dispose();
        changed = step.peer;
        break;
      }
      case 'maintain': {
        await this.peer(step.peer).maintain(step.operation);
        const after = await this.observe(step.peer);
        compareDocument(
          after,
          before.get(step.peer)!,
          this.equal,
          `${step.peer} ${step.operation} retains canonical facts`,
        );
        this.equal(
          (await this.peer(step.peer).isolationState()).canonical,
          retained.get(step.peer)!.canonical,
          `${step.peer} ${step.operation} preserves canonical native state`,
        );
        if (step.operation !== 'evict-history')
          for (const key of localFacets)
            this.equal(
              after[key],
              before.get(step.peer)![key],
              `${step.peer} maintenance preserves local ${key}`,
            );
        changed = step.peer;
        break;
      }
      case 'replay': {
        const replay = await this.openPeer(step.peer, await this.peer(step.peer).checkpoint());
        try {
          this.assertIsolation(replay);
          compareDocument(
            await replay.observe(),
            before.get(step.peer)!,
            this.equal,
            `${step.peer} fresh replay`,
          );
          this.equal(
            (await replay.isolationState()).canonical,
            retained.get(step.peer)!.canonical,
            `${step.peer} fresh replay preserves canonical native state`,
          );
          this.equal(
            (await replay.isolationState()).native,
            retained.get(step.peer)!.native,
            `${step.peer} fresh replay preserves materialized native identities`,
          );
        } finally {
          await replay.dispose();
        }
        break;
      }
      case 'expect': {
        const actual = before.get(step.peer);
        if (!actual) throw new Error(`Unknown peer ${step.peer}`);
        for (const key of Object.keys(step.state) as (keyof Observation)[])
          this.equal(actual[key], step.state[key], `${this.contract.id} ${step.peer}.${key}`);
        break;
      }
      default: {
        const unreachable: never = step;
        throw new Error(`Unsupported network step ${String(unreachable)}`);
      }
    }
    for (const peer of this.contract.peers)
      if (peer !== changed)
        this.equal(
          await this.observe(peer),
          before.get(peer),
          `${peer} isolated during ${step.type}`,
        );
    for (const peer of this.contract.peers)
      if (peer !== changed)
        this.equal(
          await this.peer(peer).isolationState(),
          retained.get(peer),
          `${peer} raw canonical/native isolation during ${step.type}`,
        );
    await this.inspect(`step ${this.steps.length - 1} ${step.type}`);
  }
  private validateAuthor(action: TraceAction, state: Observation): void {
    this.peer(action.peer);
    const label = `${action.peer} author ${action.id}`;
    const closure = new Set<string>();
    const visit = (id: string): void => {
      if (closure.has(id)) return;
      const dependency = this.actions.get(id);
      if (!dependency) throw new Error(`${label} unknown dependency ${id}`);
      closure.add(id);
      for (const parent of dependency.dependencies) visit(parent);
    };
    for (const id of action.dependencies) {
      this.equal(state.ready.includes(id), true, `${label} authors against local ready closure`);
      visit(id);
    }
    this.equal(
      state.ready.every((id) => closure.has(id)),
      true,
      `${label} observes local heads`,
    );
    const own = [...this.actions.values()].filter((prior) => prior.peer === action.peer);
    const sequence =
      own.reduce((maximum, prior) => (prior.sequence > maximum ? prior.sequence : maximum), 0n) +
      1n;
    this.equal(action.sequence, sequence, `${label} symbolic author sequence`);
    const maximum = action.dependencies.reduce((value, id) => {
      const time = this.actions.get(id)!.lamport;
      return time > value ? time : value;
    }, 0n);
    this.equal(action.lamport, maximum + 1n, `${label} causal Lamport counter`);
    for (const intent of action.intents)
      if (intent.type === 'control') {
        for (const id of intent.actions) {
          const target = this.actions.get(id);
          this.equal(target?.peer, action.peer, `${label} history owner`);
          this.equal(target?.group, intent.group, `${label} history group`);
          this.equal(closure.has(id), true, `${label} history target in causal closure`);
        }
        if (intent.previous)
          this.equal(
            closure.has(intent.previous),
            true,
            `${label} previous control in causal closure`,
          );
      }
  }
  private async inspect(context: string): Promise<void> {
    const observations: Observation[] = [];
    const facts: string[] = [];
    for (const peer of this.contract.peers) {
      const state = await this.observe(peer);
      observations.push(state);
      facts.push(
        JSON.stringify(canonicalPayloads((await this.peer(peer).isolationState()).canonical)),
      );
      const label = `${context} ${peer}`;
      const prior = this.inventories.get(peer);
      for (const id of prior?.held ?? [])
        this.equal(state.held.includes(id), true, `${label} retains prior canonical action ${id}`);
      for (const [id, count] of Object.entries(prior?.variants ?? {}))
        this.equal(
          state.variants[id] >= count,
          true,
          `${label} retains prior payload variants ${id}`,
        );
      this.inventories.set(peer, structuredClone({ held: state.held, variants: state.variants }));
      const statuses = [...state.ready, ...state.pending, ...state.quarantined];
      this.equal(new Set(statuses).size, statuses.length, `${label} disjoint readiness`);
      this.equal([...statuses].sort(), [...state.held].sort(), `${label} total readiness`);
      for (const id of state.ready) {
        const action = this.actions.get(id);
        if (!action) throw new Error(`${label} unknown ready action ${id}`);
        for (const dependency of action.dependencies)
          this.equal(
            state.ready.includes(dependency),
            true,
            `${label} ${id} ready dependency ${dependency}`,
          );
        if (action.sequence > 1n) {
          const predecessor = [...this.actions.values()].find(
            (a) => a.peer === action.peer && a.sequence === action.sequence - 1n,
          );
          this.equal(
            predecessor !== undefined && state.ready.includes(predecessor.id),
            true,
            `${label} contiguous actor chain ${id}`,
          );
        }
      }
      this.equal(state.retainedActions, state.held, `${label} retains every canonical action`);
      const heads = state.ready.filter(
        (id) => !state.ready.some((other) => this.actions.get(other)?.dependencies.includes(id)),
      );
      this.equal(state.heads, heads, `${label} semantic heads`);
      for (const id of [...state.pending, ...state.quarantined])
        for (const intent of this.actions.get(id)?.intents ?? [])
          if (intent.type === 'insert')
            this.equal(
              state.nativeText[intent.cell],
              undefined,
              `${label} unready native body excluded`,
            );
      const visible = Object.values(state.visible).flat();
      this.equal(
        new Set(visible).size,
        visible.length,
        `${label} unique visible native identities`,
      );
      this.equal(
        visible.every((id) => state.nativeIds[id] !== undefined && !state.hidden.includes(id)),
        true,
        `${label} visible native coverage`,
      );
      this.equal(
        Object.keys(state.cellRuns).sort(),
        Object.keys(state.nativeText).sort(),
        `${label} total cell ownership`,
      );
      this.equal(
        Object.keys(state.nativeIds).sort(),
        Object.keys(state.nativeText)
          .filter((id) => state.nativeText[id] !== '')
          .sort(),
        `${label} native coverage`,
      );
      const occupied = new Set<string>();
      for (const [alias, native] of Object.entries(state.nativeIds)) {
        this.equal(
          native.length,
          state.nativeText[alias].length,
          `${label} ${alias} UTF-16 length`,
        );
        for (let clock = native.clock; clock < native.clock + native.length; clock++) {
          const key = `${native.client}:${clock}`;
          this.equal(occupied.has(key), false, `${label} disjoint native ranges`);
          occupied.add(key);
        }
      }
      for (const [kind, aliases] of [
        ['node', Object.keys(state.rawParents)],
        ['flow', Object.keys(state.flowParents)],
        ['run', [...Object.keys(state.runFlows), ...Object.values(state.cellRuns)]],
      ] as const)
        for (const alias of aliases)
          this.equal(state.resources[alias]?.kind, kind, `${label} ${alias} resource coverage`);
      for (const [domain, values] of [
        ['native', state.nativeIds],
        ['resource', state.resources],
      ] as const)
        for (const [alias, value] of Object.entries(values)) {
          const key = `${domain}:${alias}`;
          if (this.bindings.has(key))
            this.equal(value, this.bindings.get(key), `${label} ${key} retained identity`);
          else this.bindings.set(key, structuredClone(value));
        }
    }
    // Pending/quarantined inventory may differ without changing the ready projection.
    const inventory = new Set<keyof Observation>([
      'held',
      'pending',
      'quarantined',
      'variants',
      'retainedActions',
    ]);
    for (let left = 0; left < observations.length; left++)
      for (let right = left + 1; right < observations.length; right++) {
        const a = observations[left],
          b = observations[right];
        if (JSON.stringify(a.ready) === JSON.stringify(b.ready))
          for (const key of Object.keys(a) as (keyof Observation)[])
            if (!localFacets.has(key) && !inventory.has(key))
              this.equal(a[key], b[key], `${context} equal ready sets.${key}`);
        if (facts[left] === facts[right])
          compareDocument(a, b, this.equal, `${context} equal canonical sets`);
      }
  }
  /** Generator sees only the chosen peer's real local view. Owners provide valid semantic edits,
   * including deletion and undo; this scheduler never invents reducer outcomes.
   */
  async generate(
    turns: number,
    local: (
      peer: string,
      state: Observation,
      random: SeededRandom,
    ) => LocalStep | undefined | Promise<LocalStep | undefined>,
  ): Promise<void> {
    if (!Number.isSafeInteger(turns) || turns < 0) throw new Error('Invalid turn count');
    for (let turn = 0; turn < turns; turn++) {
      const peers = this.contract.peers;
      const peer = peers[this.random.next(peers.length)];
      const choice = this.random.next(10);
      const queued = [...this.messages].filter(([, message]) => message.state === 'queued');
      if (choice < 5) {
        const command = await local(peer, await this.observe(peer), this.random);
        if (command) {
          const owner = command.type === 'author' ? command.action.peer : command.peer;
          if (owner !== peer) throw new Error('Generator must edit the chosen local peer');
          await this.step(command);
        }
      } else if (choice === 5) {
        const modes: SyncMode[] = [
          'bidirectional',
          'outbound-only',
          'inbound-only',
          'disconnected',
        ];
        await this.step({ type: 'mode', peer, mode: modes[this.random.next(modes.length)] });
      } else if (choice === 6) {
        const to = peers.filter((candidate) => candidate !== peer)[
          this.random.next(peers.length - 1)
        ];
        const held = (await this.observe(peer)).held;
        const actions = this.random.next(2) ? held : held.filter(() => this.random.next(2) === 0);
        await this.step({
          type: 'send',
          id: `generated-${this.serial++}`,
          from: peer,
          to,
          actions,
          route: 'peer',
        });
      } else if (choice === 7 && queued.length) {
        await this.step({
          type: 'duplicate',
          source: queued[this.random.next(queued.length)][0],
          id: `generated-${this.serial++}`,
        });
      } else if (choice === 8 && queued.length) {
        await this.step({ type: 'deliver', id: queued[this.random.next(queued.length)][0] });
      } else if (choice === 9) await this.step({ type: 'restart', peer });
    }
  }
  /** Connect the frozen semantic corpus to independent ports without exposing expectations. */
  async executeContractStep(step: Exclude<Step, { type: 'expect' }>): Promise<void> {
    if (step.type !== 'deliver') {
      await this.step(step);
      return;
    }
    await this.step({
      type: 'link',
      from: step.from,
      to: step.to,
      enabled: true,
      reverseControl: false,
    });
    const id = `contract-${this.serial++}`;
    await this.step({ ...step, type: 'send', id });
    if (this.messages.has(id)) await this.step({ type: 'deliver', id });
  }
  async dispose(): Promise<void> {
    const ports = [...this.replicas.values()];
    this.replicas.clear();
    const results = await Promise.allSettled(ports.map((port) => port.dispose()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

/** Save exact scheduled commands, including the failing command. BigInt counters use decimal
 * strings only in the test artifact; envelopes continue to use the MW-01 wire codec.
 */
export function encodeNetworkTrace(trace: NetworkTrace): string {
  return (
    JSON.stringify(
      trace,
      (key, value) =>
        (key === 'sequence' || key === 'lamport') && typeof value === 'bigint'
          ? value.toString()
          : value,
      2,
    ) + '\n'
  );
}
export function decodeNetworkTrace(text: string): NetworkTrace {
  const trace = JSON.parse(text, (key, value) => {
    if (key !== 'sequence' && key !== 'lamport') return value;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error('Invalid trace counter');
    const counter = BigInt(value);
    if (counter > (1n << 64n) - 1n) throw new Error('Trace counter overflow');
    return counter;
  }) as NetworkTrace;
  if (trace.version !== 1 || trace.contract.version !== 3 || !Array.isArray(trace.steps))
    throw new Error('Unsupported network trace');
  new SeededRandom(trace.seed);
  return trace;
}
export async function replayNetworkTrace(
  factory: ReplicaFactory,
  trace: NetworkTrace,
  equal: Equal,
): Promise<void> {
  const network = await ReplicaNetwork.open(factory, trace.contract, equal, trace.seed);
  try {
    for (const step of trace.steps) await network.step(step);
  } finally {
    await network.dispose();
  }
}

/** MW-08 supplies the real factory; the existing corpus runner retains its exact expectations. */
export function replicaTraceAdapter(factory: ReplicaFactory, equal: Equal, seed = 0): TraceAdapter {
  let network: ReplicaNetwork | undefined;
  const active = () => {
    if (!network) throw new Error('Replica adapter is not initialized');
    return network;
  };
  return {
    async initialize(trace) {
      if (network) throw new Error('Replica adapter is already initialized');
      network = await ReplicaNetwork.open(factory, trace, equal, seed);
    },
    execute: (step) => active().executeContractStep(step),
    observe: (peer) => active().observe(peer),
    checkpoint: (peer) => active().step({ type: 'replay', peer }),
    async dispose() {
      const prior = network;
      network = undefined;
      await prior?.dispose();
    },
  };
}
