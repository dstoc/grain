import { describe, expect, it } from 'vitest';

import { serializeCommonMarkHtml } from './commonmark-html.js';
import {
  DEFAULT_COMMONMARK_SKIP_EXAMPLES,
  DEFAULT_COMMONMARK_SKIP_REASONS,
} from './commonmark.default-skips.js';

interface CommonMarkFixture {
  example: number;
  section: string;
  markdown: string;
  html: string;
}

const INLINE_RELEVANT_SECTIONS = new Set([
  'Inlines',
  'Textual content',
  'Code spans',
  'Emphasis and strong emphasis',
  'Links',
  'Images',
  'Autolinks',
]);

const { default: commonmarkSpec } = await import('../../../data/commonmark.0.31.2.spec.json?raw');
const fixtures = JSON.parse(commonmarkSpec) as CommonMarkFixture[];

const selectedFixtures = fixtures.filter((fixture) =>
  INLINE_RELEVANT_SECTIONS.has(fixture.section),
);

const skippedFixtures = selectedFixtures.filter(
  (fixture) =>
    DEFAULT_COMMONMARK_SKIP_EXAMPLES.has(fixture.example) ||
    DEFAULT_COMMONMARK_SKIP_REASONS.has(fixture.example),
);

const executedFixtures = selectedFixtures.filter(
  (fixture) =>
    !DEFAULT_COMMONMARK_SKIP_EXAMPLES.has(fixture.example) &&
    !DEFAULT_COMMONMARK_SKIP_REASONS.has(fixture.example),
);

describe('commonmark html serializer', () => {
  it('reports the inline-relevant fixture coverage summary', () => {
    console.info(
      `[commonmark] total=${selectedFixtures.length} executed=${executedFixtures.length} skipped=${skippedFixtures.length}`,
    );
    expect(executedFixtures.length + skippedFixtures.length).toBe(selectedFixtures.length);
  });

  for (const fixture of selectedFixtures) {
    const skipReason =
      DEFAULT_COMMONMARK_SKIP_REASONS.get(fixture.example) ??
      (DEFAULT_COMMONMARK_SKIP_EXAMPLES.has(fixture.example) ? 'default skip' : undefined);
    const test = skipReason === undefined ? it : it.skip;
    test(`${fixture.example} ${fixture.section}`, () => {
      expect(serializeCommonMarkHtml(fixture.markdown)).toBe(fixture.html);
    });
  }
});
