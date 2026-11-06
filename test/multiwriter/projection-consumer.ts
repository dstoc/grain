import type { CommandReplica } from './commands/replica.js';
import { encodeEnvelope } from '../../src/markdown/multiwriter/actions/codec.js';
import { actionKey } from '../../src/markdown/multiwriter/actions/references.js';
import { resourceKey } from '../../src/markdown/multiwriter/layout/index.js';
import { reduceActivity } from '../../src/markdown/multiwriter/visibility/activity.js';
import { finish } from '../../src/markdown/multiwriter/ingest/work.js';
import type * as full from '../../src/markdown/multiwriter/projection/project.js';
import type { OwnershipResult } from '../../src/markdown/multiwriter/ownership/ownership.js';
import type { NodeId, RunId, TapeId } from '../../src/markdown/multiwriter/contracts.js';
import type { EffectRef } from '../../src/markdown/multiwriter/visibility/activity.js';
import { MaterializedProjection } from '../../src/markdown/multiwriter/materialization/projection.js';
import { reconstructProvenance } from '../../src/markdown/multiwriter/reference/provenance.js';
import type { StructuralProjectionChange } from '../../src/markdown/multiwriter/materialization/projection-changes.js';

export type Projection = ReturnType<typeof full.projectWithActivity>;
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
function sequence(p: CommandReplica) {
  if (!('readyActions' in p.document)) throw new Error('Expected indexed source');
  return p.document.readyActions();
}
export function seed(p: CommandReplica) {
  const consumer = new MaterializedProjection(),
    actions = sequence(p),
    publication = p.document.publication.status().publication!;
  const prepared = finish(
    consumer.prepare(
      p.genesis,
      actions,
      publication.native,
      reduceActivity([...actions]),
      new Map([...actions].map((a) => [actionKey(a.id), encodeEnvelope(a)])),
    ),
  );
  prepared.commit();
  return { consumer, value: prepared.value };
}
/** Controlled, deliberately full snapshot comparison outside C timing. This is
 * test input construction, not B's producer or a structural-refinement proof.
 */
export function change(p: CommandReplica, base: Projection): StructuralProjectionChange {
  const next = p.document.publication.status().publication!,
    actions = sequence(p),
    activity = reduceActivity([...actions]);
  const old = new Map(base.ownership.nodeAllocations.map((n) => [resourceKey(n.id), n]));
  const signature = (ownership: OwnershipResult, node: NodeId) => {
    const allocation = ownership.nodeAllocation(node);
    return json({
      placement: ownership.blockPlacement(node),
      flow: allocation.flow && ownership.flowBlock(allocation.flow),
      raw: allocation.flow && ownership.raw(allocation.flow),
    });
  };
  const oldVisibility = new Map(base.visibility.nodes.map((n) => [resourceKey(n.node), n]));
  const nextVisibility = new Map(next.value.visibility.nodes.map((n) => [resourceKey(n.node), n]));
  const nodes = next.value.ownership.nodeAllocations
    .filter(
      (n) =>
        !old.has(resourceKey(n.id)) ||
        json(oldVisibility.get(resourceKey(n.id))) !==
          json(nextVisibility.get(resourceKey(n.id))) ||
        signature(base.ownership, n.id) !== signature(next.value.ownership, n.id) ||
        (n.id.birth.type === 'action' &&
          base.activity.isActive(n.id.birth.action) !== activity.isActive(n.id.birth.action)),
    )
    .map((n) => n.id);
  const containers = next.value.ownership.nodeAllocations
    .filter(
      (n) =>
        old.has(resourceKey(n.id)) &&
        json(base.ownership.children(n.id)) !== json(next.value.ownership.children(n.id)),
    )
    .map((n) => n.id);
  const roots = new Map<string, RunId>(),
    tapes = new Map<string, TapeId>();
  for (const id of nodes) {
    const allocation = next.value.ownership.nodeAllocation(id);
    if (!allocation.flow) continue;
    roots.set(resourceKey(id), next.value.ownership.homeForFlow(allocation.flow)!.run);
    for (const ownership of [base.ownership, next.value.ownership]) {
      if (ownership === base.ownership && !old.has(resourceKey(id))) continue;
      for (const entry of ownership.raw(allocation.flow)) {
        const tape =
          entry.type === 'cell'
            ? entry.assignment.cell.tape
            : entry.type === 'slot'
              ? next.native.marker(entry.slot.boundary).tape
              : undefined;
        if (tape) tapes.set(resourceKey(tape), tape);
      }
    }
  }
  const beforeActions = new Set(base.activity.actions.map((a) => actionKey(a.id)));
  const semanticChanges = [...actions].filter(
    (a) =>
      !a.effects.some((e) => e.type === 'SetGroupActive') &&
      (!beforeActions.has(actionKey(a.id)) ||
        base.activity.isActive(a.id) !== activity.isActive(a.id)),
  );
  const requirements = new Map<string, EffectRef[]>(
    [...nodes, ...containers].map((n) => [resourceKey(n), []]),
  );
  for (const entry of next.value.ownership.destinationRequirements)
    for (const id of entry.nodes)
      requirements
        .get(resourceKey(id))
        ?.push({ action: entry.order.action.id, ordinal: entry.order.ordinal });
  const newActions = [...actions].filter((a) => !beforeActions.has(actionKey(a.id)));
  const action = newActions.at(-1) ?? actions.at(-1)!;
  return {
    base,
    family:
      action.effects[0]?.type === 'SetGroupActive'
        ? 'control'
        : semanticChanges.some((a) => a.effects.some((e) => e.type === 'SplitFlow'))
          ? 'split'
          : semanticChanges.some((a) => a.effects.some((e) => e.type === 'JoinFlow'))
            ? 'join'
            : 'text',
    replay: { from: 0, to: actions.length, reason: 'controlled-snapshot' },
    action,
    revision: {},
    actions,
    semanticChanges,
    native: next.native,
    activity,
    structure: { value: next.value.ownership, commit() {} },
    nodes,
    containers,
    rootRuns: roots,
    tapes: [...tapes.values()],
    nativeTapes: [
      ...new Map(
        newActions.flatMap((a) => a.nativeManifest).map((b) => [resourceKey(b.tape), b.tape]),
      ).values(),
    ],
    requirements,
    birthContent: reconstructProvenance(p.genesis.layout, [...actions]).birthContent.filter(
      (entry) => !old.has(resourceKey(entry.node)),
    ),
  };
}
