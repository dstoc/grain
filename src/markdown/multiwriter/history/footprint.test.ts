import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { enter, insertText, deleteBackwardAtStart } from '../authoring/index.js';
import { resourceKey } from '../layout/index.js';
import { captureFootprint } from './scope.js';
import { captureDiagnostics } from '../diagnostics.js';

for (const from of [0, 2, 4])
  test(`split footprint matches full pre-command assignment scanning after join (${from})`, () => {
    const p = commandReplica(commandGenesis('abcd\n\nefgh\n\ntail'), undefined, 'materialized');
    try {
      const session = p.editor.session();
      session.edit(deleteBackwardAtStart, { nodeId: p.handle(p.nodes()[1]) });
      session.edit(insertText, { nodeId: p.handle(p.nodes()[0]), from: 1, text: 'X' });
      const before = p.document.publication.status().publication!;
      const result = session.edit(enter, { nodeId: p.handle(p.nodes()[0]), from });
      if (result.status !== 'applied') throw new Error('Expected split');
      const native = p.document.publication.status().publication!.native;
      const expected = result.envelope.effects.flatMap((effect) =>
        effect.type !== 'SplitFlow'
          ? []
          : effect.basis.ranges.flatMap(({ range }) => {
              const start = native.marker(range.start).index,
                end = native.marker(range.end).index;
              return before.value.ownership.assignments.flatMap((cell) => {
                if (resourceKey(cell.cell.tape) !== resourceKey(range.tape)) return [];
                const left = native.marker(cell.cell.start).index,
                  right = native.marker(cell.cell.end).index;
                return Math.max(start, left) < Math.min(end, right)
                  ? [
                      before.value.ownership.flowBlock(
                        before.value.ownership.runLayout(cell.run).flow,
                      ),
                    ]
                  : [];
              });
            }),
      );
      const { value, report } = captureDiagnostics(() =>
        captureFootprint(result.envelope, before, native),
      );
      expect(value.endpoints).toEqual(expected);
      expect(report.work['driver/history.footprintAssignmentExports'] ?? 0).toBe(0);
      expect(report.work['driver/ownership.cellsInstalled'] ?? 0).toBe(0);
    } finally {
      p.close();
    }
  });
