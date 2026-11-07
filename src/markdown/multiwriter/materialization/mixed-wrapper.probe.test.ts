import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { seed, change } from '../../../../test/multiwriter/projection-consumer.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { captureDiagnostics } from '../diagnostics.js';
import { resourceKey } from '../layout/index.js';
test('ordinary list split must not rebuild a neighboring nonempty quote', () => {
  const p = commandReplica(
    commandGenesis('3. abcdef\n4. next\n\n> unrelated\n\n- later\n\ntail'),
    undefined,
    'materialized',
  );
  try {
    const seeded = seed(p),
      quote = seeded.value.view.root.children[1];
    expect(
      p.editor.edit({ local: 'probe', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }).status,
    ).toBe('applied');
    const input = change(p, seeded.value),
      { value: result, report } = captureDiagnostics(() =>
        seeded.consumer.prepareStructural(input),
      );
    expect(result.state).toBe('prepared');
    if (result.state !== 'prepared') throw new Error(result.reason);
    expect(result.value.view).toEqual(p.view());
    console.info(
      JSON.stringify({
        quote: resourceKey(quote.origin.representative),
        rawNodes: report.resources['projection.regionRawNodes'],
        work: report.work,
      }),
    );
    expect(report.resources['projection.regionRawNodes'] ?? []).not.toContain(
      resourceKey(quote.origin.representative),
    );
  } finally {
    p.close();
  }
});
