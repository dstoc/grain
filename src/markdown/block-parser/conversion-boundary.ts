import { parseAtxHeading } from './handlers/sections.js';
import { parseListItem } from './handlers/lists.js';
import { parseQuotePrefix } from './prefix-resolution.js';

// Find the start of the first editable's content when a paragraph is parsed
// into blocks. Only the first line can contain the conversion markers.
export function conversionContentStart(source: string): number | undefined {
  const line = source.split('\n', 1)[0];
  let rest = line;
  while (true) {
    const heading = parseAtxHeading(rest);
    if (heading) return line.length - heading.content.length;

    const quote = parseQuotePrefix(rest);
    if (quote !== undefined) {
      rest = quote;
      continue;
    }
    const list = parseListItem(rest);
    if (list) {
      rest = list.content;
      continue;
    }
    return rest === line ? undefined : line.length - rest.length;
  }
}
