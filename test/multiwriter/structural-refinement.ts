/** Experimental A-only replay. The production reader guard never calls this helper. */
import { commandGenesis, commandReplica } from './commands/replica.js';
import type { CommandReplica } from './commands/replica.js';
import { insertParagraph } from '../../src/markdown/multiwriter/authoring/index.js';
import { actionKey } from '../../src/markdown/multiwriter/actions/references.js';
import { action, C, resource } from '../../src/markdown/multiwriter/actions/test-fixtures.js';
import type { TapeId } from '../../src/markdown/multiwriter/contracts.js';
import { resourceKey } from '../../src/markdown/multiwriter/layout/index.js';
import { NativeTapeCache } from '../../src/markdown/multiwriter/text/cache.js';
import { reconstructProvenance } from '../../src/markdown/multiwriter/reference/provenance.js';
import { reduceActivity } from '../../src/markdown/multiwriter/visibility/activity.js';
import { selectInterpretations } from '../../src/markdown/multiwriter/projection/interpretation.js';
import { MaterializedCells } from '../../src/markdown/multiwriter/materialization/cells.js';
import { OwnershipResources } from '../../src/markdown/multiwriter/materialization/resources.js';
import { replayOwnershipSuffix } from '../../src/markdown/multiwriter/materialization/ownership.js';
import type { OwnershipCheckpoint } from '../../src/markdown/multiwriter/materialization/ownership.js';
import { refineCheckpoint } from '../../src/markdown/multiwriter/materialization/coupled.js';
import { cellKey, assignmentKey } from '../../src/markdown/multiwriter/ownership/cells.js';
import type { NativeInsertion } from '../../src/markdown/multiwriter/text/types.js';

export function replay(p: CommandReplica, resume?: OwnershipCheckpoint) {
  const actions = p.document.store.snapshot().ready;
  const native = p.document.publication.status().publication!.native;
  const provenance = reconstructProvenance(p.genesis.layout, actions);
  const snapshots = [
    ...p.genesis.layout.allocations,
    ...actions.flatMap((a) => a.allocations),
  ].flatMap((a) => (a.type === 'tape' ? [native.snapshot(a.id)] : []));
  const index = resume
    ? resume.index.refine(snapshots, native)
    : new MaterializedCells(snapshots, undefined, native);
  const activity = reduceActivity(actions);
  const interpretations = selectInterpretations(activity, p.genesis.initialProperties);
  const resources = OwnershipResources.create(
    p.genesis.layout,
    provenance.actions,
    snapshots,
    index,
    {
      allocationsIndexed: 0,
      homesDerived: 0,
      snapshotMarkersValidated: 0,
      skeletonCellsValidated: 0,
      resourceRebuilds: 0,
      homeTapesValidated: 0,
    },
  );
  const refined = resume && refineCheckpoint(resume, snapshots, index);
  const result = replayOwnershipSuffix(
    {
      genesis: p.genesis.layout,
      actions: provenance.actions,
      snapshots,
      isActive: (order) =>
        activity.isEffectActive({ action: order.action.id, ordinal: order.ordinal }) &&
        interpretations.effectEligible({ action: order.action.id, ordinal: order.ordinal }),
      interpretationEligible: (order) =>
        interpretations.eligible({ action: order.action.id, ordinal: order.ordinal }),
    },
    activity,
    refined,
    () => {},
    index,
    resources,
    { coverageFlowsTraversed: 0, coverageCellsVisited: 0 },
  );
  return { ...result, snapshots, index, publication: p.document.publication.status().publication! };
}
/** The original marker identities and native body are retained and certified at
 * exactly the prefix that authored them. Numeric positions are local input only.
 */
export function markers(
  p: CommandReplica,
  tape: TapeId,
  index: number,
  count = 1,
  affinity: 'left' | 'right' = 'right',
) {
  const ready = p.document.store.snapshot().ready;
  const sequence =
    ready
      .filter((a) => a.id.actor === C)
      .reduce((n, a) => (a.id.sequence > n ? a.id.sequence : n), 0n) + 1n;
  const envelope = action(C, sequence, ready);
  const writer = new NativeTapeCache(10_000_000);
  try {
    writer.apply('G', p.genesis.body);
    for (const a of ready) writer.apply(actionKey(a.id), a);
    const operations: NativeInsertion[] = Array.from({ length: count }, (_, i) => ({
      type: 'marker',
      tape,
      index: index + i,
      marker: resource('marker', i, envelope.id),
      affinity,
    }));
    const prepared = writer.prepare('refinement', operations);
    prepared.commit();
    const body = { ...envelope, groupId: { ...envelope.groupId, sequence }, ...prepared.body };
    p.document.certifyLocal(body);
    p.document.store.append(body);
    p.editor.refresh();
    return body;
  } finally {
    writer.destroy();
  }
}
/** Explicit ordered subdivision map; it never assigns the final owner's cells
 * backward to the prefix. Empty native gaps remain distinct by marker identity.
 */
export function refinementMap(before: ReturnType<typeof replay>, after: ReturnType<typeof replay>) {
  return before.value.assignments.map((old) => ({
    old: cellKey(old.cell),
    owner: assignmentKey(old),
    next: after.index.range(old.cell).map((cell) => ({
      cell: cellKey(cell.range),
      owner: assignmentKey(after.value.cells(cell.range)[0]),
    })),
  }));
}
export function rawObservation(o: ReturnType<typeof replay>['value']) {
  return {
    assignments: o.assignments,
    flows: o.flowPlacements,
    runs: o.runLayouts,
    buckets: o.buckets,
    homes: o.homeBindings,
    requirements: o.destinationRequirements,
    nodes: o.nodeAllocations.map((n) => [
      n,
      o.blockPlacement(n.id),
      o.children(n.id),
      n.flow ? o.raw(n.flow) : null,
    ]),
  };
}
export function firstTape(p: CommandReplica) {
  const allocation = p.genesis.layout.allocations.find((a) => a.type === 'tape');
  if (!allocation || allocation.type !== 'tape') throw new Error('No tape');
  return allocation.id;
}
export function contentTape(p: CommandReplica, text: string) {
  const item = p.genesis.body.nativeManifest.find((e) => e.type === 'text' && e.text === text);
  if (!item) throw new Error(`Missing ${text}`);
  return item.tape;
}
export function label(id: TapeId) {
  return resourceKey(id);
}

/** Two original paragraphs, three valid actions. The join is known to the split
 * author. Subdivision alone changes the full reference's old adjacency decision.
 */
export function emptyHomeCounterexample(markerCount = 2) {
  const p = commandReplica(commandGenesis('abc\n\n<!-- -->'), undefined, 'materialized');
  try {
    const genesis = p.genesis;
    const nodes = genesis.layout.allocations.filter((a) => a.type === 'node' && a.flow);
    const first = nodes[0],
      q = nodes[1];
    if (first?.type !== 'node' || !first.flow || q?.type !== 'node' || !q.flow)
      throw new Error('Missing flows');
    const run = genesis.layout.allocations.find((a) => a.type === 'run' && a.flow === first.flow);
    const letter = genesis.body.nativeManifest.find((a) => a.type === 'text' && a.text === 'b');
    if (run?.type !== 'run' || letter?.type !== 'text') throw new Error('Missing run');
    const snapshot = p.document.publication.status().publication!.native.snapshot(letter.tape);
    const textAt = snapshot.parts.find(
      (a) =>
        a.type === 'text' &&
        a.native.client === letter.native.client &&
        a.native.clock === letter.native.clock,
    )!;
    const boundary = snapshot.parts.find(
      (a) => a.type === 'marker' && a.index === textAt.index + 1,
    );
    if (boundary?.type !== 'marker') throw new Error('Missing boundary');
    const envelope = action();
    const occurrence = resource('occurrence', 0, envelope.id);
    const slot = {
      run: run.id,
      boundary: boundary.marker,
      side: 'right' as const,
      predecessor: null,
    };
    const join = {
      ...envelope,
      allocations: [{ type: 'occurrence' as const, id: occurrence, slot }],
      effects: [
        {
          type: 'JoinFlow' as const,
          source: q.flow,
          destination: slot,
          occurrence,
          liftedChildren: [],
        },
      ],
    };
    // Full exact-author admission validates the original occurrence and its slot.
    p.document.certifyLocal(join);
    p.document.store.append(join);
    p.editor.refresh();
    const split = p.editor
      .session('split')
      .edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 1 });
    if (split.status !== 'applied') throw new Error('Split failed');
    const before = replay(p),
      beforeCanonical = p.document.store.encodeUpdate(),
      beforeText = p.nodes().map((n) => n.content);
    const tape = genesis.layout.allocations.filter((a) => a.type === 'tape')[1];
    if (tape.type !== 'tape') throw new Error('Missing empty tape');
    const markerAction = markers(p, tape.id, 1, markerCount);
    const candidate = replay(p, before.state);
    return {
      p,
      join,
      split,
      markerAction,
      before,
      beforeCanonical,
      beforeText,
      candidate,
      source: first,
      q,
      tape: tape.id,
    };
  } catch (error) {
    p.close();
    throw error;
  }
}
