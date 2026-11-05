import type { RangeRef, RunId, TapeId } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { cellKey } from '../ownership/cells.js';
import type { HomeBinding } from '../ownership/homes.js';
import type { MaterializedCells } from './cells.js';
import { PersistentMap } from './map.js';

/** Private home bindings do not change with effect activity. Only a changed
 * native tape can change its two reserved edge cells. No prior wrapper, activity
 * callback or preparation context is retained by a refined domain.
 */
export class MaterializedHomes {
  private runs = new PersistentMap<HomeBinding>();
  private tapes = new PersistentMap<HomeBinding>();
  private edges = new PersistentMap<readonly string[]>();
  private index?: MaterializedCells;
  refine(bindings: readonly HomeBinding[], touched: readonly TapeId[], index: MaterializedCells) {
    const next = new MaterializedHomes();
    next.runs = this.runs.fork();
    next.tapes = this.tapes.fork();
    next.edges = this.edges.fork();
    next.index = index;
    const dirty = new Map(touched.map((tape) => [resourceKey(tape), tape]));
    for (const home of bindings) {
      const run = resourceKey(home.run),
        tape = resourceKey(home.cell.tape);
      if (next.runs.has(run) || next.tapes.has(tape))
        throw new Error('Duplicate private home binding');
      next.runs.set(run, home);
      next.tapes.set(tape, home);
      dirty.set(tape, home.cell.tape);
    }
    for (const [key, tape] of dirty) {
      if (!next.tapes.has(key)) throw new Error('Native tape lacks a private home binding');
      const cells = index.tape(tape),
        edges = [cells[0], cells.at(-1)!];
      if (edges.some((cell) => cell.fragments.length))
        throw new Error('Reserved home cells must remain text-free; bracket edge typing');
      next.edges.set(
        key,
        edges.map((cell) => cellKey(cell.range)),
      );
    }
    return next;
  }
  has(run: RunId): boolean {
    return this.runs.has(resourceKey(run));
  }
  home(run: RunId): HomeBinding {
    const home = this.runs.get(resourceKey(run));
    if (!home) throw new Error('Cut run is not a bound home root');
    return structuredClone(home);
  }
  isReserved(cell: RangeRef): boolean {
    return this.edges.get(resourceKey(cell.tape))?.includes(cellKey(cell)) ?? false;
  }
  assertCapture(range: RangeRef): void {
    const home = this.tapes.get(resourceKey(range.tape));
    if (!home || !this.index) throw new Error('Capture uses a tape without a home binding');
    const start = this.index.position(range.tape, range.start),
      end = this.index.position(range.tape, range.end);
    if (
      start <= this.index.position(range.tape, home.cell.start) ||
      end >= this.index.position(range.tape, home.cell.end)
    )
      throw new Error('Structural captures need interior home endpoints');
    this.index.range(range);
  }
  binding(tape: TapeId): HomeBinding {
    const home = this.tapes.get(resourceKey(tape));
    if (!home) throw new Error('Native tape lacks a private home binding');
    return home;
  }
}
