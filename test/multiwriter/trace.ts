import type {
  DeliveryRoute,
  NativeRange,
  RawRole,
  ResourceId,
  ResourceKind,
  SyncMode,
} from '../../src/markdown/multiwriter/contracts.js';

/** Symbolic IDs are stable aliases, not numeric offsets or a second wire format.
 * Adapters bind them to real genesis/action allocations and native identities.
 */
export interface SeedBlock {
  readonly id: string;
  readonly parent: string | null;
  readonly role: RawRole;
  readonly flow?: string;
  readonly run?: string;
  readonly tape?: string;
  readonly cells?: readonly { readonly id: string; readonly text: string }[];
}
export type Intent =
  | {
      readonly type: 'split';
      readonly source: string;
      readonly basis: readonly string[];
      readonly after: string | null;
      readonly marker: string;
      readonly retainedSide: 'left' | 'right';
      readonly node: string;
      readonly flow: string;
      readonly run: string;
      readonly parent: string;
      readonly predecessor: string | null;
    }
  | { readonly type: 'join'; readonly source: string; readonly destinationSlot: string }
  | {
      readonly type: 'transfer';
      readonly cells: readonly string[];
      readonly destinationSlot: string;
      readonly run: string;
    }
  | {
      readonly type: 'insert';
      readonly cell: string;
      readonly text: string;
      readonly tape: string;
      readonly slot: string;
    }
  | {
      readonly type: 'delete-subtree';
      readonly tag: string;
      readonly target: string;
      readonly observedNodes: readonly string[];
      readonly coveredCells: readonly string[];
      readonly joinedFlows: readonly string[];
    }
  | { readonly type: 'delete-text'; readonly tag: string; readonly cells: readonly string[] }
  | {
      readonly type: 'move';
      readonly node: string;
      readonly parent: string;
      readonly predecessor: string | null;
      readonly standaloneFlow: string | null;
    }
  | { readonly type: 'create'; readonly block: SeedBlock; readonly predecessor: string | null }
  | {
      readonly type: 'interpret';
      readonly packet: string;
      readonly source: string;
      readonly presentation: 'paragraph' | 'section' | 'code';
      readonly mask: readonly string[];
      readonly wrappers: readonly string[];
    }
  | {
      readonly type: 'control';
      readonly group: string;
      readonly actions: readonly string[];
      readonly active: boolean;
      readonly previous: string | null;
    };
export interface TraceAction {
  readonly id: string;
  readonly peer: string;
  readonly sequence: bigint;
  readonly lamport: bigint;
  readonly dependencies: readonly string[];
  readonly group: string;
  readonly intents: readonly Intent[];
}
/** Each specified facet is an exact comparison, including identity and order. */
export interface Observation {
  /** Actual native IDs, not aliases. Bindings cannot change across peers or replay. */
  readonly nativeIds: Readonly<Record<string, NativeRange>>;
  readonly resources: Readonly<Record<string, ResourceId<ResourceKind>>>;
  readonly held: readonly string[];
  readonly ready: readonly string[];
  readonly pending: readonly string[];
  readonly quarantined: readonly string[];
  readonly variants: Readonly<Record<string, number>>;
  readonly heads: readonly string[];
  readonly rawParents: Readonly<Record<string, string | null>>;
  readonly flowParents: Readonly<Record<string, string>>;
  readonly runFlows: Readonly<Record<string, string>>;
  readonly cellRuns: Readonly<Record<string, string>>;
  /** Includes zero-character cells, hidden cells and retracted insertions. */
  readonly nativeText: Readonly<Record<string, string>>;
  /** Retained authored ranges, resolved to stable cell aliases; not effective ownership.
   * Marker and empty-location identities require separate native assertions. */
  readonly skeletons: Readonly<Record<string, readonly string[]>>;
  readonly slots: Readonly<Record<string, string>>;
  readonly visible: Readonly<Record<string, readonly string[]>>;
  readonly hidden: readonly string[];
  readonly deletedNodes: readonly string[];
  readonly view: readonly {
    readonly id: string;
    readonly parent: string | null;
    readonly kind: string;
  }[];
  readonly addresses: Readonly<
    Record<
      string,
      | {
          readonly type: 'group';
          readonly representative: string;
          readonly constituents: readonly string[];
        }
      | { readonly type: 'slot'; readonly run: string; readonly slot: string }
      | {
          readonly type: 'empty-root';
          readonly parent: string;
          readonly predecessor: string | null;
        }
    >
  >;
  readonly undo: readonly string[];
  readonly redo: readonly string[];
  readonly retainedActions: readonly string[];
  readonly genesis: string;
  readonly emittedActions: readonly string[];
  readonly activePackets: readonly string[];
  readonly markdown: string;
}
export type Step =
  | { readonly type: 'author'; readonly action: TraceAction }
  | {
      readonly type: 'deliver';
      readonly from: string;
      readonly to: string;
      readonly actions: readonly string[];
      readonly route: DeliveryRoute;
      /** Fault injection changes a complete envelope, never the reference expected state. */
      readonly mutation?: {
        readonly action: string;
        readonly type:
          | 'fork-payload'
          | 'unsupported-version'
          | 'native-delete'
          | 'unknown-resource';
      };
    }
  | { readonly type: 'mode'; readonly peer: string; readonly mode: SyncMode }
  | { readonly type: 'restart'; readonly peer: string }
  | {
      readonly type: 'maintain';
      readonly peer: string;
      readonly operation: 'evict-history' | 'drop-caches' | 'checkpoint-reload';
    }
  | { readonly type: 'expect'; readonly peer: string; readonly state: Partial<Observation> };
export interface ContractTrace {
  readonly version: 3;
  readonly id: string;
  readonly sections: readonly string[];
  readonly purpose: string;
  readonly genesis: 'G';
  /** Actor byte ordering is A < B < C. Each instance has its own session, even for one account. */
  readonly peers: readonly ['A', 'B', 'C'];
  /** Parent-before-child order; entries with the same parent are in sibling order.
   * Genesis birth occurrences form a predecessor chain per parent.
   */
  readonly seed: readonly SeedBlock[];
  readonly steps: readonly Step[];
}
export interface TraceAdapter {
  initialize(trace: ContractTrace): void | Promise<void>;
  execute(step: Exclude<Step, { readonly type: 'expect' }>): void | Promise<void>;
  observe(peer: string): Observation | Promise<Observation>;
  dispose(): void | Promise<void>;
}
/** No reference reducer is hidden here. MW-07/08 supply the independent real adapter. */
export async function runContractTrace(
  adapter: TraceAdapter,
  trace: ContractTrace,
  equal: (actual: unknown, expected: unknown, context: string) => void,
): Promise<void> {
  const nativeBindings = new Map<string, NativeRange>();
  const resourceBindings = new Map<string, ResourceId<ResourceKind>>();
  async function inspect(peer: string, checkpoint: string): Promise<Observation> {
    const actual = await adapter.observe(peer);
    const label = `${trace.id} ${checkpoint} ${peer}`;
    const visible = Object.values(actual.visible).flat();
    equal(new Set(visible).size, visible.length, `${label} visible identities occur once`);
    equal(
      visible.every((id) => actual.nativeIds[id] !== undefined),
      true,
      `${label} visible native coverage`,
    );
    equal(
      visible.some((id) => actual.hidden.includes(id)),
      false,
      `${label} hidden identities are not visible`,
    );
    equal(
      Object.keys(actual.cellRuns).sort(),
      Object.keys(actual.nativeText).sort(),
      `${label} total cell ownership`,
    );
    equal(
      Object.keys(actual.nativeIds).sort(),
      Object.keys(actual.nativeText)
        .filter((id) => actual.nativeText[id] !== '')
        .sort(),
      `${label} native identity coverage`,
    );
    for (const [kind, aliases] of [
      ['node', Object.keys(actual.rawParents)],
      ['flow', Object.keys(actual.flowParents)],
      ['run', [...Object.keys(actual.runFlows), ...Object.values(actual.cellRuns)]],
    ] as const) {
      for (const alias of aliases)
        equal(actual.resources[alias]?.kind, kind, `${label} ${alias} resource coverage`);
    }
    for (const [alias, resource] of Object.entries(actual.resources)) {
      if (resourceBindings.has(alias))
        equal(
          resource,
          resourceBindings.get(alias),
          `${label} ${alias} retained resource identity`,
        );
      else resourceBindings.set(alias, structuredClone(resource));
    }
    const occupied = new Set<string>();
    for (const [alias, native] of Object.entries(actual.nativeIds)) {
      equal(native.length, actual.nativeText[alias].length, `${label} ${alias} UTF-16 length`);
      if (nativeBindings.has(alias))
        equal(native, nativeBindings.get(alias), `${label} ${alias} retained native identity`);
      else nativeBindings.set(alias, { ...native });
      for (let clock = native.clock; clock < native.clock + native.length; clock++) {
        const key = `${native.client}:${clock}`;
        equal(occupied.has(key), false, `${label} ${alias} unique native range`);
        occupied.add(key);
      }
    }
    return actual;
  }
  try {
    await adapter.initialize(trace);
    for (const peer of trace.peers) await inspect(peer, 'genesis');
    for (const [index, step] of trace.steps.entries()) {
      if (step.type !== 'expect') {
        await adapter.execute(step);
        const peer =
          step.type === 'author' ? step.action.peer : step.type === 'deliver' ? step.to : step.peer;
        await inspect(peer, `step ${index}`);
        continue;
      }
      const actual = await inspect(step.peer, `step ${index}`);
      for (const facet of Object.keys(step.state) as (keyof Observation)[]) {
        equal(actual[facet], step.state[facet], `${trace.id} step ${index} ${step.peer}.${facet}`);
      }
    }
  } finally {
    await adapter.dispose();
  }
}
