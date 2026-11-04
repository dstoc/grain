import type {
  ActionEnvelope,
  ActionId,
  Allocation,
  ResourceId,
  ResourceKind,
} from '../contracts.js';

export function actionKey(id: ActionId): string {
  return `${id.actor}:${id.sequence}`;
}
function resourceKey(id: ResourceId<ResourceKind>): string {
  return `${id.birth.type === 'genesis' ? `G:${id.birth.genesisId}` : actionKey(id.birth.action)}:${id.ordinal}`;
}

/** Shape/domain checks belong to the codec; existence is evaluated only in the author's past. */
export function validReferences(
  action: ActionEnvelope,
  closure: readonly ActionEnvelope[],
  genesis: readonly Allocation[],
): boolean {
  const resources = new Map<string, ResourceKind>();
  for (const allocation of [...genesis, ...closure.flatMap((entry) => entry.allocations)])
    resources.set(resourceKey(allocation.id), allocation.id.kind);
  const allocated = new Set<number>();
  for (const allocation of action.allocations) {
    const id = allocation.id;
    if (
      id.birth.type !== 'action' ||
      actionKey(id.birth.action) !== actionKey(action.id) ||
      allocated.has(id.ordinal)
    )
      return false;
    allocated.add(id.ordinal);
    resources.set(resourceKey(id), id.kind);
  }
  const past = new Set(closure.map((entry) => actionKey(entry.id)));
  function visit(value: unknown): boolean {
    if (!value || typeof value !== 'object' || value instanceof Uint8Array) return true;
    if (Array.isArray(value)) return value.every(visit);
    const record = value as Record<string, unknown>;
    if ('kind' in record && 'birth' in record && 'ordinal' in record) {
      const id = value as ResourceId<ResourceKind>;
      return resources.get(resourceKey(id)) === id.kind;
    }
    if ('actor' in record && 'sequence' in record) return past.has(actionKey(value as ActionId));
    return Object.values(record).every(visit);
  }
  // Allocation IDs are validated above. Their resource references may target same-action births.
  return (
    action.allocations.every(visit) &&
    action.nativeManifest.every(visit) &&
    action.effects.every(visit)
  );
}
