import { countWork } from '../diagnostics.js';
import type {
  ActionEnvelope,
  CellAssignment,
  ActionId,
  BlockSlot,
  FlowId,
  InlineSlot,
  NativeTextRange,
  NodeId,
  ProjectionAddress,
  RangeRef,
  RunId,
} from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { resolveAddress } from '../projection/addresses.js';
import { projectedNode, viewNodes } from './selection.js';
import type { NativeView } from '../ingest/publication.js';
import type { HistoryPublication } from './selection.js';
import type { OwnershipResult } from '../ownership/ownership.js';

/** A classification reads one immutable ownership publication. Resolve a run
 * once rather than exporting every retained run for each captured cell.
 */
function runFlows(ownership: OwnershipResult): (run: RunId) => FlowId {
  const flows = new Map<string, FlowId>();
  return (run) => {
    const key = resourceKey(run);
    let flow = flows.get(key);
    if (!flow) {
      flow = ownership.runLayout(run).flow;
      flows.set(key, flow);
    }
    return flow;
  };
}

export interface Footprint {
  readonly action: ActionId;
  readonly envelope: Pick<ActionEnvelope, 'allocations' | 'effects'>;
  /** Source edges disappear on move/join. Capture their parents before append. */
  readonly sourceParents: readonly NodeId[];
  readonly endpoints: readonly NodeId[];
}
export function captureFootprint(
  envelope: ActionEnvelope,
  before: HistoryPublication,
  native: NativeView,
): Footprint {
  const sourceParents: NodeId[] = [],
    endpoints: NodeId[] = [];
  const runFlow = runFlows(before.value.ownership);
  const known = (node: NodeId) =>
    before.value.ownership.nodeAllocations.some((n) => resourceKey(n.id) === resourceKey(node));
  const ranges = (values: readonly RangeRef[], selected?: readonly CellAssignment[]) => {
    for (const range of values) {
      // Same-action ranges are classified after allocation; they have no pre-edit owner.
      if (
        range.tape.birth.type === 'action' &&
        range.tape.birth.action.actor === envelope.id.actor &&
        range.tape.birth.action.sequence === envelope.id.sequence
      )
        continue;
      const start = native.marker(range.start).index,
        end = native.marker(range.end).index;
      const assignments = selected ?? before.value.ownership.assignments;
      if (!selected) countWork('history.footprintAssignmentExports', assignments.length);
      for (const cell of assignments) {
        countWork('history.footprintCellsInspected');
        if (resourceKey(cell.cell.tape) !== resourceKey(range.tape)) continue;
        const cellStart = native.marker(cell.cell.start).index,
          cellEnd = native.marker(cell.cell.end).index;
        if (Math.max(start, cellStart) >= Math.min(end, cellEnd)) continue;
        endpoints.push(before.value.ownership.flowBlock(runFlow(cell.run)));
      }
    }
  };
  const source = (node: NodeId) => {
    if (!known(node)) return;
    const placement = before.value.ownership.blockPlacement(node);
    if (placement) sourceParents.push(placement.slot.parent);
  };
  for (const effect of envelope.effects) {
    if (effect.type === 'MoveBlock') {
      if (
        effect.node.birth.type === 'action' &&
        effect.node.birth.action.actor === envelope.id.actor &&
        effect.node.birth.action.sequence === envelope.id.sequence
      )
        continue;
      if (
        before.value.ownership.nodeAllocations.some(
          (n) => resourceKey(n.id) === resourceKey(effect.node),
        )
      )
        source(effect.node);
    } else if (effect.type === 'JoinFlow') {
      // A validated retained flow has a permanent home; a same-action flow has
      // no pre-edit parent. Neither query needs the complete flow/node inventory.
      if (before.value.ownership.homeForFlow(effect.source)) {
        const node = before.value.ownership.flowBlock(effect.source);
        endpoints.push(node);
        const placement = before.value.ownership.blockPlacement(node);
        if (placement) sourceParents.push(placement.slot.parent);
      }
    } else if (effect.type === 'TransferRange') ranges(effect.ranges);
    else if (effect.type === 'SplitFlow') {
      const single =
        envelope.effects.every(
          (e) =>
            ['SplitFlow', 'InsertText', 'DeleteText', 'SetProperties'].includes(e.type) ||
            (e.type === 'MoveBlock' &&
              resourceKey(e.node) === resourceKey(effect.newNode) &&
              e.standaloneFlow !== null &&
              resourceKey(e.standaloneFlow) === resourceKey(effect.newFlow)),
        ) &&
        envelope.effects.filter((e) => e.type === 'SplitFlow').length === 1 &&
        !envelope.allocations.some(
          (a) => a.type === 'run' && resourceKey(a.id) === resourceKey(effect.cut.run),
        );
      // Use the pre-command source traversal. New cut markers are read from the
      // final native view, but ownership is never copied backward from the result.
      const selected = single
        ? before.value.ownership
            .raw(before.value.ownership.runLayout(effect.cut.run).flow)
            .flatMap((entry) => (entry.type === 'cell' ? [entry.assignment] : []))
        : undefined;
      ranges(
        effect.basis.ranges.map((r) => r.range),
        selected,
      );
    } else if (effect.type === 'LiftChildren')
      for (const placement of effect.placements) source(placement.node);
  }
  return structuredClone({
    action: envelope.id,
    envelope: { allocations: envelope.allocations, effects: envelope.effects },
    sourceParents,
    endpoints,
  });
}
export type ScopeClassification = 'inside' | 'outside' | 'mixed' | 'unresolved';
export function validScope(p: HistoryPublication, scope: ProjectionAddress): boolean {
  return (
    scope.type === 'node' &&
    resolveAddress(scope, p.value.ownership, p.value.visibility).state === 'available' &&
    (() => {
      const node = projectedNode(p.value.view.root, scope.representative);
      return (
        !!node &&
        node.origin.constituents.length === scope.constituents.length &&
        scope.constituents.every((id) =>
          node.origin.constituents.some((c) => resourceKey(c) === resourceKey(id)),
        )
      );
    })()
  );
}

/** Classify exact retained intervals, including hidden cells, against current ownership. */
export function classifyFootprints(
  p: HistoryPublication,
  footprints: readonly Footprint[],
  scope: ProjectionAddress,
): ScopeClassification {
  if (scope.type !== 'node') return 'unresolved';
  const ownership = p.value.ownership;
  const runFlow = runFlows(ownership);
  const projected = projectedNode(p.value.view.root, scope.representative);
  if (!projected) return 'unresolved';
  const roots = new Set(
    viewNodes(projected).flatMap((n) => n.origin.constituents.map(resourceKey)),
  );
  const visible = new Set(
    viewNodes(p.value.view.root).flatMap((n) => n.origin.constituents.map(resourceKey)),
  );
  const classifications: boolean[] = [];
  let unresolved = false;
  const node = (id: NodeId) => {
    let current: NodeId | undefined = id;
    const seen = new Set<string>();
    while (current) {
      const key = resourceKey(current);
      if (roots.has(key)) {
        classifications.push(true);
        return;
      }
      if (visible.has(key)) {
        classifications.push(false);
        return;
      }
      if (seen.has(key) || !ownership.nodeAllocations.some((n) => resourceKey(n.id) === key)) {
        unresolved = true;
        return;
      }
      seen.add(key);
      let parent: NodeId | undefined = ownership.blockPlacement(current)?.slot.parent;
      // Non-section inline headers lift raw children into their containing view.
      // Visible origins take precedence; hidden children use the same retained rule.
      while (parent) {
        const allocation = ownership.nodeAllocations.find(
          (n) => resourceKey(n.id) === resourceKey(parent!),
        );
        if (allocation?.role !== 'inline') break;
        const joined =
          allocation.flow &&
          ownership.flowPlacements.find(
            (f) => resourceKey(f.flow) === resourceKey(allocation.flow!),
          )?.parent.type === 'flow';
        if (!joined && p.value.interpretations.properties(parent).presentation === 'section') break;
        parent = ownership.blockPlacement(parent)?.slot.parent;
      }
      current = parent;
    }
    classifications.push(false);
  };
  const flow = (id: FlowId) => node(ownership.flowBlock(id));
  const slot = (value: InlineSlot) => flow(ownership.resolveSlot(value).run.flow);
  const blockSlot = (value: BlockSlot) => {
    ownership.resolveBlockSlot(value);
    node(value.parent);
  };
  const range = (value: RangeRef) => {
    const cells = ownership.cells(value);
    if (!cells.length) {
      unresolved = true;
      return;
    }
    for (const cell of cells) {
      flow(runFlow(cell.run));
    }
  };
  const text = (value: NativeTextRange) => {
    const owners = ownership.inlineOwner(value);
    if (!owners.length && value.length) unresolved = true;
    owners.forEach(node);
  };
  for (const footprint of footprints) {
    if (
      !p.value.activity.actions.some(
        (a) => a.id.actor === footprint.action.actor && a.id.sequence === footprint.action.sequence,
      )
    )
      return 'unresolved';
    footprint.sourceParents.forEach(node);
    footprint.endpoints.forEach(node);
    // Only semantic node births count; tape/marker/run infrastructure does not.
    for (const allocation of footprint.envelope.allocations)
      if (allocation.type === 'node') {
        node(allocation.id);
        if (allocation.birthSlot) blockSlot(allocation.birthSlot);
      }
    for (const effect of footprint.envelope.effects) {
      switch (effect.type) {
        case 'InsertText':
          effect.ranges.forEach(text);
          break;
        case 'DeleteText':
          effect.observed.forEach(text);
          break;
        case 'SetProperties':
          node(effect.node);
          break;
        case 'MoveBlock':
          node(effect.node);
          blockSlot(effect.slot);
          break;
        case 'JoinFlow':
          flow(effect.source);
          slot(effect.destination);
          effect.liftedChildren.forEach(node);
          break;
        case 'SplitFlow':
          effect.basis.ranges.forEach((r) => range(r.range));
          slot(effect.cut);
          node(effect.newNode);
          blockSlot(effect.outerSlot);
          break;
        case 'TransferRange':
          effect.ranges.forEach(range);
          slot(effect.destination);
          break;
        case 'DeleteSubtree':
          node(effect.scope.target);
          effect.scope.observedNodes.forEach(node);
          effect.scope.ownedIntervals.forEach(range);
          effect.scope.joinedFlows.forEach(flow);
          break;
        case 'Interpret':
          node(effect.packet.source);
          effect.packet.wrappers.forEach(node);
          effect.packet.derivedInlineOutputs?.forEach(node);
          effect.packet.placements.forEach((placement) => {
            node(placement.node);
            blockSlot(placement.slot);
          });
          effect.packet.syntaxMask.forEach(text);
          effect.packet.synthesizedText.forEach(text);
          break;
        case 'LiftChildren':
          effect.placements.forEach((placement) => {
            node(placement.node);
            blockSlot(placement.slot);
          });
          break;
        case 'SetGroupActive':
          break;
      }
    }
  }
  if (unresolved || !classifications.length) return 'unresolved';
  return classifications.every(Boolean)
    ? 'inside'
    : classifications.every((v) => !v)
      ? 'outside'
      : 'mixed';
}
