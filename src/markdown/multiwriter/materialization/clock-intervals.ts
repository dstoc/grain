import type { MapRoot } from './map.js';

export interface ClockInterval {
  readonly start: number;
  readonly end: number;
}
const maxima = new WeakMap<object, number>();
/** Immutable search paths share summaries. Call at preparation time so selected
 * reads cannot trigger deferred work on a complete interval inventory.
 */
export function summarizeIntervals<T extends ClockInterval>(
  root: MapRoot<T> | undefined,
  visit: () => void,
): number {
  if (!root) return -Infinity;
  let maximum = maxima.get(root);
  if (maximum === undefined) {
    maximum = Math.max(
      root.value.end,
      summarizeIntervals(root.left, visit),
      summarizeIntervals(root.right, visit),
    );
    maxima.set(root, maximum);
    visit();
  }
  return maximum;
}
export function clockIntervalsAt<T extends ClockInterval>(
  root: MapRoot<T> | undefined,
  clock: number,
  visit: () => void,
  includeEnd = false,
): T[] {
  const found: T[] = [];
  const query = (node: MapRoot<T> | undefined): void => {
    if (!node) return;
    const maximum = maxima.get(node);
    if (maximum === undefined) throw new Error('Interval root was not prepared');
    if (includeEnd ? maximum < clock : maximum <= clock) return;
    visit();
    query(node.left);
    if (node.value.start > clock) return;
    if (includeEnd ? clock <= node.value.end : clock < node.value.end) found.push(node.value);
    query(node.right);
  };
  query(root);
  return found;
}
