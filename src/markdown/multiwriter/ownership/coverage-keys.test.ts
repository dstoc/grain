import { afterEach, expect, test, vi } from 'vitest';
import { A, B, resource } from '../actions/test-fixtures.js';
import type { CellAssignment, RangeRef } from '../contracts.js';
import { captureDiagnostics } from '../diagnostics.js';
import { LayoutPrefix, resourceKey } from '../layout/index.js';
import * as cells from './cells.js';
import { CellIndex } from './cells.js';
import { HomeIndex } from './homes.js';
import { reduceOwnership } from './ownership.js';
import { NativeFixture } from './test-fixtures.js';
import { CoverageKeys, traverse } from './traversal.js';
import type { RunAttachment, RunOrigin } from './traversal.js';

const fixtures: NativeFixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.destroy();
});
function state() {
  const f = new NativeFixture();
  fixtures.push(f);
  const layout = new LayoutPrefix(f.genesis);
  const index = new CellIndex([f.peers.get('A')!.snapshot(f.id('tP', 'tape'))]);
  const home = structuredClone(f.homes[0]);
  const owners = new Map<string, CellAssignment>(
    index.cells.map((cell) => [cells.cellKey(cell.range), { ...home, cell: cell.range }]),
  );
  const roots = new Map<string, readonly RunOrigin[]>([[resourceKey(f.id('fP', 'flow')), [home]]]);
  const attachments = new Map<string, RunAttachment>();
  return {
    f,
    layout,
    index,
    owners,
    roots,
    attachments,
    walk(keys?: CoverageKeys) {
      return traverse(f.id('fP', 'flow'), layout, index, owners, roots, attachments, keys);
    },
  };
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

test('memoizes only strings and preserves all logical identity fields on detached frozen records', () => {
  const base: RangeRef = {
    tape: resource('tape', 1),
    start: resource('marker', 2),
    end: resource('marker', 3),
  };
  const ranges: RangeRef[] = [base, structuredClone(base)];
  for (const field of ['tape', 'start', 'end'] as const) {
    for (const change of [
      { kind: 'run' },
      { ordinal: 900 },
      { birth: { type: 'genesis', genesisId: 'escaped " \\ 😀\n' } },
      { birth: { type: 'action', action: { actor: A, sequence: 1n } } },
      { birth: { type: 'action', action: { actor: B, sequence: 1n } } },
      { birth: { type: 'action', action: { actor: A, sequence: (1n << 64n) - 1n } } },
      { birth: { type: 'action', action: { actor: A, sequence: (1n << 64n) - 2n } } },
    ]) {
      const changed = structuredClone(base);
      Object.assign(changed[field], change);
      ranges.push(changed);
    }
  }
  const origins: RunOrigin[] = [];
  for (const field of ['run', 'occurrence'] as const) {
    const origin = { run: resource('run', 4), occurrence: resource('occurrence', 5) };
    for (const change of ranges.slice(2, 9).map((range) => range.tape)) {
      const changed = structuredClone(origin);
      Object.assign(changed[field], change);
      origins.push(changed);
    }
  }
  const keys = new CoverageKeys();
  for (const range of ranges) {
    freeze(range);
    expect(keys.cell(range)).toBe(cells.cellKey(range));
    expect(keys.cell(range)).toBe(cells.cellKey(range));
  }
  expect(keys.cell(ranges[0])).toBe(keys.cell(ranges[1]));
  expect(new Set(ranges.slice(1).map((range) => keys.cell(range))).size).toBe(ranges.length - 1);
  for (const origin of origins) {
    freeze(origin);
    expect(keys.assignment(origin)).toBe(cells.assignmentKey(origin));
    expect(keys.assignment(origin)).toBe(cells.assignmentKey(structuredClone(origin)));
  }
});

test('computes lazily, retries failed serialization, and recomputes changed objects in a new audit', () => {
  const range = {
    tape: resource('tape', 1),
    start: resource('marker', 2),
    end: resource('marker', 3),
  };
  const origin = { run: resource('run', 4), occurrence: resource('occurrence', 5) };
  const cell = vi.spyOn(cells, 'cellKey');
  const assignment = vi.spyOn(cells, 'assignmentKey');
  const first = new CoverageKeys();
  expect(cell).not.toHaveBeenCalled();
  expect(assignment).not.toHaveBeenCalled();
  const before = [first.cell(range), first.assignment(origin)];
  expect(first.cell(range)).toBe(before[0]);
  expect(first.assignment(origin)).toBe(before[1]);
  expect(cell).toHaveBeenCalledTimes(1);
  expect(assignment).toHaveBeenCalledTimes(1);
  Object.assign(range.end, { ordinal: 99 });
  Object.assign(origin.occurrence, { ordinal: 100 });
  const second = new CoverageKeys();
  expect(second.cell(range)).not.toBe(before[0]);
  expect(second.assignment(origin)).not.toBe(before[1]);
  expect(cell).toHaveBeenCalledTimes(2);
  expect(assignment).toHaveBeenCalledTimes(2);
  const broken = { ...range, end: undefined } as unknown as RangeRef;
  expect(() => second.cell(broken)).toThrow(TypeError);
  expect(() => second.cell(broken)).toThrow(TypeError);
  Object.assign(broken, { end: range.end });
  expect(second.cell(broken)).toBe(second.cell(range));
  expect(cell).toHaveBeenCalledTimes(5);
});

test('cached traversal preserves complete ordered entries, reads, diagnostics and short-circuit order', () => {
  const s = state();
  const range = vi.spyOn(s.index, 'range');
  const order = vi.spyOn(s.layout, 'occurrenceOrder');
  const plain = captureDiagnostics(() => s.walk());
  const reads = { ranges: [...range.mock.calls], orders: [...order.mock.calls] };
  range.mockClear();
  order.mockClear();
  const keys = new CoverageKeys();
  const cached = captureDiagnostics(() => s.walk(keys));
  expect(cached.value).toEqual(plain.value);
  expect(cached.report.work).toEqual(plain.report.work);
  expect(cached.report.resources).toEqual(plain.report.resources);
  expect(range.mock.calls).toEqual(reads.ranges);
  expect(order.mock.calls).toEqual(reads.orders);
  const assignment = vi.spyOn(keys, 'assignment');
  s.owners.clear();
  expect(s.walk(keys).filter((entry) => entry.type === 'cell')).toEqual([]);
  expect(assignment).not.toHaveBeenCalled();
});

test.each(['missing', 'foreign', 'reversed'] as const)(
  'retains %s native endpoint rejection with keys',
  (kind) => {
    const s = state();
    const run = s.layout.runLayout(s.f.id('rP', 'run'));
    const original = run.skeleton[0];
    const invalid: RangeRef =
      kind === 'missing'
        ? { ...original, end: resource('marker', 999) }
        : kind === 'foreign'
          ? { ...original, tape: resource('tape', 999) }
          : { ...original, start: original.end, end: original.start };
    vi.spyOn(s.layout, 'runLayout').mockReturnValue({ ...run, skeleton: [invalid] });
    const expected =
      kind === 'reversed' ? 'Invalid open native range' : 'Unknown native range endpoint';
    expect(() => s.walk()).toThrow(expected);
    expect(() => s.walk(new CoverageKeys())).toThrow(expected);
  },
);

test.each(['run', 'flow', 'cell'] as const)(
  'retains repeated/cyclic %s errors with keys',
  (kind) => {
    const s = state();
    const flow = s.f.id('fP', 'flow');
    if (kind === 'run') {
      const roots = s.roots.get(resourceKey(flow))!;
      s.roots.set(resourceKey(flow), [...roots, ...roots]);
    } else if (kind === 'cell') {
      const run = s.layout.runLayout(s.f.id('rP', 'run'));
      vi.spyOn(s.layout, 'runLayout').mockReturnValue({
        ...run,
        skeleton: [...run.skeleton, ...run.skeleton],
      });
    } else {
      const occurrence = s.f.id('P:birth', 'occurrence');
      const slot = s.f.slots.get('P:start')!;
      vi.spyOn(s.layout, 'occurrenceOrder').mockReturnValue([
        { id: occurrence, slot, order: null },
      ]);
      vi.spyOn(s.layout, 'flowPlacements', 'get').mockReturnValue([
        {
          flow,
          parent: { type: 'flow', occurrence, slot },
        },
      ]);
    }
    const expected =
      kind === 'cell'
        ? 'Duplicate cell in run skeleton'
        : `Repeated or cyclic ${kind === 'flow' ? 'inline flow' : 'run'} traversal`;
    expect(() => s.walk()).toThrow(expected);
    expect(() => s.walk(new CoverageKeys())).toThrow(expected);
  },
);

test('generic traversal recomputes keys after a foreign reader mutates an origin', () => {
  const s = state();
  const root = s.roots.get(resourceKey(s.f.id('fP', 'flow')))![0];
  const original = s.owners.get.bind(s.owners);
  let reads = 0;
  vi.spyOn(s.owners, 'get').mockImplementation((key) => {
    if (++reads === 2) Object.assign(root, { occurrence: resource('occurrence', 999) });
    return original(key);
  });
  const entries = s.walk().filter((entry) => entry.type === 'cell');
  expect(entries).toHaveLength(1);
  expect(reads).toBe(s.index.cells.length);
});

test('production uses new keys for each audit and returned raw reads remain uncached', () => {
  const s = state();
  const entry = s.f.author('A1', (f) => [f.split('P', 'S', 'P1')]);
  const audits = new Set<CoverageKeys>();
  const original = CoverageKeys.prototype.cell;
  const spy = vi.spyOn(CoverageKeys.prototype, 'cell').mockImplementation(function (
    this: CoverageKeys,
    range,
  ) {
    audits.add(this);
    return original.call(this, range);
  });
  const result = reduceOwnership({
    genesis: s.f.genesis,
    actions: [entry],
    snapshots: s.f.homes.map((home) => s.f.peers.get('A')!.snapshot(home.cell.tape)),
    isActive: () => true,
  });
  const flow = structuredClone(s.f.id('fS', 'flow'));
  expect(audits.size).toBeGreaterThanOrEqual(3);
  spy.mockClear();
  const raw = result.raw(flow);
  expect(raw.filter((entry) => entry.type === 'cell').length).toBeGreaterThan(0);
  expect(spy).not.toHaveBeenCalled();
  const held = result.assignments;
  Object.assign(entry.action.id, { sequence: 999n });
  expect(result.assignments).toEqual(held);
  expect(result.raw(flow)).toEqual(raw);
});

test('equal native coordinates on distinct tapes retain distinct keys and ownership', () => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [{ id: 'p', text: '😀' }],
    },
    {
      id: 'Q',
      parent: 'root',
      role: 'inline',
      flow: 'fQ',
      run: 'rQ',
      tape: 'tQ',
      cells: [{ id: 'q', text: '😀' }],
    },
  ]);
  fixtures.push(f);
  const snapshots = f.homes.map((home) => f.peers.get('A')!.snapshot(home.cell.tape));
  const text = snapshots[0].parts.find((part) => part.type === 'text')!;
  const native = text.native;
  snapshots[1] = {
    ...snapshots[1],
    parts: snapshots[1].parts.map((part) => (part.type === 'text' ? { ...part, native } : part)),
  };
  freeze(snapshots);
  const result = reduceOwnership({
    genesis: f.genesis,
    actions: [],
    snapshots,
    isActive: () => true,
  });
  const keys = new CoverageKeys();
  const owners = snapshots.map((snapshot) => result.owner({ tape: snapshot.tape, native }));
  expect(keys.cell(owners[0].cell)).not.toBe(keys.cell(owners[1].cell));
  expect(owners.map((owner) => owner.run)).toEqual([f.id('rP', 'run'), f.id('rQ', 'run')]);
  for (const owner of owners) {
    expect(result.tokenOwners({ ...native, tape: owner.cell.tape, length: 2 })).toEqual([owner]);
    expect(() => result.tokenOwners({ ...native, tape: owner.cell.tape, length: 1 })).toThrow(
      'surrogate pair',
    );
  }
});

test.each(['duplicate', 'unreachable'] as const)(
  'keeps the reference %s coverage failure',
  (kind) => {
    const s = state();
    const placements = s.layout.flowPlacements;
    vi.spyOn(LayoutPrefix.prototype, 'flowPlacements', 'get').mockReturnValue(
      kind === 'duplicate' ? [...placements, ...placements] : [],
    );
    expect(() =>
      reduceOwnership({
        genesis: s.f.genesis,
        actions: [],
        snapshots: [s.f.peers.get('A')!.snapshot(s.f.id('tP', 'tape'))],
        isActive: () => true,
      }),
    ).toThrow(
      kind === 'duplicate'
        ? 'Cell emitted more than once'
        : 'Owned cell is unreachable in raw traversal',
    );
  },
);

test('reserved-home ownership is still checked after a cross-tape transfer', () => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [{ id: 'P1', text: 'a' }],
    },
    { id: 'Q', parent: 'root', role: 'inline', flow: 'fQ', run: 'rQ', tape: 'tQ', cells: [] },
  ]);
  fixtures.push(f);
  f.author('A1', (f) => [f.transfer(['P1'], 'Q:end', 'rT')]);
  const original = HomeIndex.prototype.isReserved;
  vi.spyOn(HomeIndex.prototype, 'isReserved').mockImplementation(function (this: HomeIndex, range) {
    return (
      cells.cellKey(range) === cells.cellKey(f.ranges.get('P1')!) || original.call(this, range)
    );
  });
  expect(() => f.reduce('A')).toThrow('Reserved home cell lost its root assignment');
});
