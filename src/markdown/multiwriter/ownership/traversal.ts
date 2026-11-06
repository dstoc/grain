import { countWork, touchWork } from '../diagnostics.js';
import type { CellAssignment, FlowId, InlineSlot, OccurrenceId, RunId } from '../contracts.js';
import type { LayoutPrefix } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import type { LocatedText } from '../text/types.js';
import { assignmentKey, cellKey, sameId } from './cells.js';
import type { CellIndex } from './cells.js';

export interface RunOrigin {
  readonly run: RunId;
  readonly occurrence: OccurrenceId;
}
export interface RunAttachment extends RunOrigin {
  readonly destination: InlineSlot;
}
export type RawInlineEntry =
  | { readonly type: 'slot'; readonly slot: InlineSlot }
  | {
      readonly type: 'attachment';
      readonly occurrence: OccurrenceId;
      readonly target: RunId | FlowId;
    }
  | {
      readonly type: 'cell';
      readonly assignment: CellAssignment;
      readonly fragments: readonly LocatedText[];
    };

/** Walk retained skeletons, including ghost slots, filtering only cell emission.
 * Flow edges come from the current replay prefix, never the final joined graph.
 */
export function traverse(
  flow: FlowId,
  layout: Pick<LayoutPrefix, keyof LayoutPrefix> & {
    flowsAt?: (occurrence: OccurrenceId) => readonly FlowId[];
  },
  index: Pick<CellIndex, keyof CellIndex>,
  assignments: Pick<ReadonlyMap<string, CellAssignment>, 'get' | 'values'>,
  roots: Pick<ReadonlyMap<string, readonly RunOrigin[]>, 'get'>,
  attachments: Pick<ReadonlyMap<string, RunAttachment>, 'get'>,
): readonly RawInlineEntry[] {
  const result: RawInlineEntry[] = [];
  const visited = new Set<string>();
  const emitted = new Set<string>();
  const flows = layout.flowsAt ? [] : layout.flowPlacements;
  function walkFlow(id: FlowId): void {
    countWork('traversal.flowsVisited');
    touchWork('flows.read', resourceKey(id));
    const key = resourceKey(id);
    if (visited.has(key)) throw new Error('Repeated or cyclic inline flow traversal');
    visited.add(key);
    for (const root of roots.get(key) ?? []) walkRun(root);
  }
  function walkRun(origin: RunOrigin): void {
    countWork('traversal.runsVisited');
    const key = resourceKey(origin.run);
    if (visited.has(key)) throw new Error('Repeated or cyclic run traversal');
    visited.add(key);
    const run = layout.runLayout(origin.run);
    const slots = new Set<string>();
    function boundary(marker: InlineSlot['boundary']): void {
      for (const side of ['left', 'right'] as const) {
        const slot: InlineSlot = { run: run.run, boundary: marker, side, predecessor: null };
        const slotKey = JSON.stringify([resourceKey(marker), side]);
        if (slots.has(slotKey)) continue;
        slots.add(slotKey);
        result.push({ type: 'slot', slot });
        for (const occurrence of layout.occurrenceOrder(slot)) {
          countWork('traversal.occurrencesVisited');
          const attachment = attachments.get(resourceKey(occurrence.id));
          if (attachment) {
            result.push({ type: 'attachment', occurrence: occurrence.id, target: attachment.run });
            walkRun(attachment);
          }
          if (layout.flowsAt)
            for (const flow of layout.flowsAt(occurrence.id)) {
              result.push({ type: 'attachment', occurrence: occurrence.id, target: flow });
              walkFlow(flow);
            }
          for (const placement of flows) {
            if (
              placement.parent.type === 'flow' &&
              sameId(placement.parent.occurrence, occurrence.id)
            ) {
              result.push({
                type: 'attachment',
                occurrence: occurrence.id,
                target: placement.flow,
              });
              walkFlow(placement.flow);
            }
          }
        }
      }
    }
    for (const range of run.skeleton) {
      const cells = index.range(range);
      for (const cell of cells) {
        countWork('traversal.cellsVisited');
        boundary(cell.range.start);
        const cellId = cellKey(cell.range);
        const assignment = assignments.get(cellId);
        if (assignment && assignmentKey(assignment) === assignmentKey(origin)) {
          if (emitted.has(cellId)) throw new Error('Duplicate cell in run skeleton');
          emitted.add(cellId);
          result.push({ type: 'cell', assignment, fragments: cell.fragments });
        }
      }
      boundary(range.end);
    }
  }
  walkFlow(flow);
  return result;
}
