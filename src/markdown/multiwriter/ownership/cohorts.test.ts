import { afterEach, expect, it } from 'vitest';
import { NativeFixture } from './test-fixtures.js';
import type { OwnershipResult } from './index.js';

const fixtures: NativeFixture[] = [];
function fixture(): NativeFixture {
  const f = new NativeFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.destroy();
});
function children(f: NativeFixture, result: OwnershipResult, parent = 'root'): readonly string[] {
  return result.children(f.id(parent, 'node')).map((node) => f.alias(node));
}

it('ranks a three-cut cohort as one bucket beside an ordinary sibling and preserves an anchored follower', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'R', 'P3')]);
  f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
  f.author('C1', (f) => [f.split('P', 'M', 'P2')]);
  f.author(
    'B2',
    (f) => {
      f.createBlock(
        {
          id: 'O',
          parent: 'root',
          role: 'inline',
          flow: 'fO',
          run: 'rO',
          tape: 'tO',
          cells: [{ id: 'O0', text: 'o' }],
        },
        'P:birth',
      );
      return [];
    },
    ['B1'],
    2n,
  );
  f.author(
    'B3',
    (f) => {
      f.createBlock(
        {
          id: 'F',
          parent: 'root',
          role: 'inline',
          flow: 'fF',
          run: 'rF',
          tape: 'tF',
          cells: [{ id: 'F0', text: 'f' }],
        },
        'L:birth',
      );
      return [];
    },
    ['B2'],
    3n,
  );
  for (const delivery of [
    ['A1', 'B1', 'B2', 'B3', 'C1'],
    ['C1', 'B1', 'B2', 'B3', 'A1'],
  ]) {
    f.fresh('C', delivery);
    const result = f.reduce();
    expect(children(f, result)).toEqual(['P', 'O', 'L', 'F', 'M', 'R']);
    expect(result.buckets).toEqual([
      { roots: ['L', 'M', 'R'].map((node) => f.id(`${node}:birth`, 'occurrence')) },
    ]);
    expect(['fP', 'fL', 'fM', 'fR'].map((flow) => f.text(result, flow))).toEqual([
      'ab',
      'c',
      'd',
      'ef',
    ]);
    expect(children(f, f.reduce('C', ['B1']))).toContain('F');
    expect(children(f, f.reduce())).toEqual(children(f, result));
  }
});

it('removes an explicitly moved birth from its cohort while retaining its occurrence anchor and follower', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'R', 'P2')]);
  f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
  f.author(
    'B2',
    (f) => {
      f.createBlock({ id: 'F', parent: 'root', role: 'quote' }, 'L:birth');
      return [];
    },
    ['B1'],
    2n,
  );
  f.author('B3', (f) => [f.move('L', 'P')], ['B2'], 3n);
  f.fresh('C', ['B1', 'B2', 'B3', 'A1']);
  const moved = f.reduce();
  expect(moved.buckets).toEqual([]);
  expect(children(f, moved)).toEqual(['P', 'F', 'R']);
  expect(children(f, moved, 'P')).toEqual(['L']);
  expect(f.text(moved, 'fL')).toBe('c');
  const restored = f.reduce('C', ['B3']);
  expect(children(f, restored)).toEqual(['P', 'L', 'F', 'R']);
  expect(restored.buckets[0].roots).toEqual(
    ['L', 'R'].map((node) => f.id(`${node}:birth`, 'occurrence')),
  );
  expect(moved.resolveSlot(f.slots.get('L:end')!).slot).toEqual(f.slots.get('L:end'));
});

it('retains cohort eligibility after a cycle-rejected move', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'R', 'P2')]);
  f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
  f.author(
    'B2',
    (f) => {
      f.createBlock({ id: 'D', parent: 'L', role: 'quote' }, null);
      return [];
    },
    ['B1'],
    2n,
  );
  f.author('B3', (f) => [f.move('L', 'D')], ['B2'], 3n);
  f.fresh('C', ['B1', 'B2', 'B3', 'A1']);
  const result = f.reduce();
  expect(children(f, result)).toEqual(['P', 'L', 'R']);
  expect(children(f, result, 'L')).toEqual(['D']);
  expect(result.buckets[0].roots).toHaveLength(2);
  expect(result.blockPlacement(f.id('L', 'node'))!.occurrence).toEqual(
    f.id('L:birth', 'occurrence'),
  );
  const moveRequirement = result.destinationRequirements.find(
    (entry) => entry.order.action.id.sequence === 3n,
  )!;
  expect(moveRequirement.nodes).toEqual([f.id('L', 'node')]);
});

it('does not combine equal-text cuts with different captured permanent bases', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'L', 'P1')]);
  const range = { ...f.contentRanges.get('P')![0], start: f.ranges.get('P0')!.end };
  f.author('B1', (f) => [
    f.split('P', 'R', 'P2', 'left', 'root', 'P:birth', [
      { range, occurrence: f.id('P:birth', 'occurrence') },
    ]),
  ]);
  f.fresh('C', ['B1', 'A1']);
  const result = f.reduce();
  expect(result.buckets).toEqual([]);
  expect(children(f, result)).toEqual(['P', 'R', 'L']);
  expect(f.text(result, 'fL')).toBe('c');
  expect(f.text(result, 'fR')).toBe('def');
});
