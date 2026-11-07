/** The shared move primitive. Domain policies decide roles; this code decides cycles.
 * Callers replay retained requests in semantic order, including formerly unsafe ones.
 */
export type MoveResult = 'applied' | 'cycle' | 'role';
export interface ForestEdge<K, V> {
  readonly parent: K | null;
  readonly value: V;
}
export function replaceEdge<K, V>(
  forest: {
    get(key: K): ForestEdge<K, V> | undefined;
    has(key: K): boolean;
    set(key: K, value: ForestEdge<K, V>): unknown;
  },
  child: K,
  parent: K,
  value: V,
  allowed: boolean,
): MoveResult {
  if (!forest.has(child) || !forest.has(parent)) throw new Error('Missing forest allocation');
  if (!allowed) return 'role';
  const visited = new Set<K>();
  let ancestor: K | null = parent;
  while (ancestor !== null) {
    if (ancestor === child) return 'cycle';
    if (visited.has(ancestor)) throw new Error('Corrupt forest ancestry');
    visited.add(ancestor);
    const edge = forest.get(ancestor);
    if (!edge) throw new Error('Missing forest ancestor');
    ancestor = edge.parent;
  }
  forest.set(child, { parent, value });
  return 'applied';
}
