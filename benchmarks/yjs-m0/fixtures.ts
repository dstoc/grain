export function paragraphMarkdown(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `paragraph-${index}-contains-enough-text-for-stable-edit`,
  ).join('\n\n');
}

export function paragraphBenchmarkText(index: number): string {
  return `paragraph-${index}-contains-enough-text-for-stable-edit`;
}
