import { countWork } from '../diagnostics.js';
import type { RangeRef, TapeId, CellAssignment, ActionEnvelope } from '../contracts.js';
import type { MaterializedLayout } from './layout.js';
import type { RunAttachment, RunOrigin } from '../ownership/traversal.js';
import { cellKey } from '../ownership/cells.js';
import type { TapeSnapshot } from '../text/types.js';
import type { MaterializedCells } from './cells.js';
import type { MaterializedHomes } from './homes.js';
import type { StructuralIndex } from './structural.js';

export interface CellSubdivision {
  readonly before: RangeRef;
  readonly after: readonly RangeRef[];
  readonly reservedBefore: boolean;
  readonly reservedAfter: readonly boolean[];
}
/** A certificate of ordered content adjacency, not merely permanent-marker
 * retention. A reserved cell gaining ordinary descendants changes split reads.
 * The caller separately certifies unchanged historical order/activity/layout.
 */
export function subdivideCells(
  before: MaterializedCells,
  after: MaterializedCells,
  homes: MaterializedHomes,
  snapshots: readonly TapeSnapshot[],
): readonly CellSubdivision[] {
  const changes: CellSubdivision[] = [];
  for (const { tape } of snapshots) {
    const home = homes.binding(tape),
      edges = new Set([
        cellKey(after.adjacent(home.cell.start, 'right').range),
        cellKey(after.adjacent(home.cell.end, 'left').range),
      ]);
    for (const cell of before.tape(tape)) {
      countWork('refinement.cellsCertified');
      const next = after.range(cell.range);
      if (next.length === 1 && cellKey(next[0].range) === cellKey(cell.range)) continue;
      changes.push({
        before: cell.range,
        after: next.map((cell) => cell.range),
        reservedBefore: homes.isReserved(cell.range),
        reservedAfter: next.map((cell) => edges.has(cellKey(cell.range))),
      });
    }
  }
  return changes;
}
export interface StructuralChanges {
  /** Exact immutable inputs. These are local identities, never peer evidence. */
  readonly base: {
    readonly native?: object;
    readonly ready?: object;
    readonly genesis: object;
    readonly checkpoint?: object;
  };
  readonly candidate: {
    readonly native: object;
    readonly ready?: object;
    readonly revision: number;
    readonly checkpoint: object;
  };
  readonly payloads: readonly {
    readonly position: number;
    readonly before?: {
      readonly key: string;
      readonly bytes: Uint8Array;
      readonly decisions: string;
    };
    readonly after?: {
      readonly key: string;
      readonly bytes: Uint8Array;
      readonly decisions: string;
    };
  }[];
  /** Includes ordinary activity changes and controls even when raw replay need
   * not revisit their targets. Exact payloads and ordinals remain in the facts. */
  readonly actions: readonly ActionEnvelope[];
  readonly assignments: readonly {
    readonly key: string;
    readonly before?: CellAssignment;
    readonly after?: CellAssignment;
  }[];
  readonly layout: ReturnType<MaterializedLayout['changes']>;
  readonly derived: ReturnType<StructuralIndex['changes']>;
  readonly attachments: readonly {
    readonly key: string;
    readonly before?: RunAttachment;
    readonly after?: RunAttachment;
  }[];
  readonly roots: readonly {
    readonly key: string;
    readonly before?: readonly RunOrigin[];
    readonly after?: readonly RunOrigin[];
  }[];
  readonly subdivisions: readonly CellSubdivision[];
  readonly tapes: readonly TapeId[];
  readonly replayFrom: number;
  readonly replayTo: number;
  readonly reason:
    | 'append'
    | 'content-subdivision'
    | 'reserved-content-reader'
    | 'changed-order-or-activity'
    | 'native-withdrawal-or-reorder'
    | 'cold';
}
