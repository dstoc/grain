import { expect, test, vi } from 'vitest';
import { createProjectionAuthorValidator } from './validation.js';
import { isPropertyUpdate } from './interpretation.js';
import type { AuthorValidationContext } from '../ingest/validator.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { action, resource } from '../actions/test-fixtures.js';
import { nativeView } from '../ingest/publication.js';
import type { ActionEnvelope, ResourceId, ResourceKind } from '../contracts.js';

function fixture() {
  return new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    {
      id: 'P',
      role: 'inline',
      parent: 'root',
      flow: 'f',
      run: 'r',
      tape: 't',
      cells: [{ id: 'text', text: 'abc' }],
    },
  ]);
}
for (const values of [
  { checked: true },
  { info: 'ts' },
  { presentation: 'section' as const, marker: '#' },
  {},
])
  test(`indexed property certification checks exact author resources without materializing the closure: ${JSON.stringify(values)}`, () => {
    const f = fixture();
    try {
      const body: ActionEnvelope = {
        ...action(),
        effects: [{ type: 'SetProperties', node: f.id('P', 'node'), values }],
      };
      const native = nativeView(f.peers.get('A')!);
      const births = vi.fn(() => []);
      const validate = createProjectionAuthorValidator({ genesis: f.genesis, births });
      const full: AuthorValidationContext = { dependencies: [], native };
      expect(validate(body, full)).toBeNull();
      const allocation = vi.fn((id: ResourceId<ResourceKind>) =>
        f.genesis.allocations.find((a) => a.id.kind === id.kind && a.id.ordinal === id.ordinal),
      );
      const indexed: AuthorValidationContext = {
        get dependencies(): readonly ActionEnvelope[] {
          throw new Error('copied the causal closure');
        },
        native: {
          ...native,
          snapshot() {
            throw new Error('read a native tape');
          },
        },
        indexed: {
          past: { identity: {}, contains: () => false, allocation, groupSealed: () => false },
          resultIdentity: {},
          dependencies: [],
        },
      };
      expect(validate(body, indexed)).toBeNull();
      expect(allocation).toHaveBeenCalledExactlyOnceWith(
        body.effects[0].type === 'SetProperties' ? body.effects[0].node : null,
      );
      expect(births).toHaveBeenCalledTimes(2);
      expect(
        validate(
          { ...body, effects: [{ type: 'SetProperties', node: resource('node', 999), values }] },
          indexed,
        ),
      ).toBe('reference');
      const failure = vi.fn(() => {
        throw new Error('host birth failure');
      });
      const withFailure = createProjectionAuthorValidator({ genesis: f.genesis, births: failure });
      expect(() => withFailure(body, indexed)).toThrow('host birth failure');
    } finally {
      f.destroy();
    }
  });

test('property certification never admits native writes, births, mixed effects or controls as a pure update', () => {
  const body = {
    ...action(),
    effects: [
      { type: 'SetProperties' as const, node: resource('node', 0), values: { checked: true } },
    ],
  };
  expect(isPropertyUpdate(body)).toBe(true);
  expect(isPropertyUpdate({ ...body, nativeInsertUpdates: [new Uint8Array()] })).toBe(false);
  expect(
    isPropertyUpdate({
      ...body,
      nativeManifest: [
        {
          type: 'text',
          tape: resource('tape', 0),
          native: { client: 1, clock: 0, length: 1 },
          text: 'x',
        },
      ],
    }),
  ).toBe(false);
  expect(
    isPropertyUpdate({ ...body, allocations: [{ type: 'deletion', id: resource('deletion', 1) }] }),
  ).toBe(false);
  expect(
    isPropertyUpdate({ ...body, effects: [...body.effects, { type: 'InsertText', ranges: [] }] }),
  ).toBe(false);
  expect(isPropertyUpdate({ ...body, effects: [] })).toBe(false);
});
