import { finish } from '../ingest/work.js';
import type { Work } from '../ingest/work.js';
import type { CertifiedPast } from './validation.js';
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
  return finish(validReferencesSteps(action, closure, genesis));
}

export function* validReferencesSteps(
  action: ActionEnvelope,
  closure: readonly ActionEnvelope[],
  genesis: readonly Allocation[],
): Work<boolean> {
  const resources = new Map<string, ResourceKind>();
  for (const entries of [genesis, ...closure.map((entry) => entry.allocations)])
    for (const allocation of entries) {
      yield;
      resources.set(resourceKey(allocation.id), allocation.id.kind);
    }
  const allocated = new Set<number>();
  for (const allocation of action.allocations) {
    yield;
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
  const stack: unknown[] = [action.allocations, action.nativeManifest, action.effects];
  while (stack.length) {
    yield;
    const value = stack.pop();
    if (!value || typeof value !== 'object' || value instanceof Uint8Array) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        yield;
        stack.push(item);
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    if ('kind' in record && 'birth' in record && 'ordinal' in record) {
      const id = value as ResourceId<ResourceKind>;
      if (resources.get(resourceKey(id)) !== id.kind) return false;
    } else if ('actor' in record && 'sequence' in record) {
      if (!past.has(actionKey(value as ActionId))) return false;
    } else
      for (const item of Object.values(record)) {
        yield;
        stack.push(item);
      }
  }
  return true;
}

/** The indexed reader checks only resources mentioned by the candidate. The full
 * reference above deliberately constructs its resource map from the author array.
 */
export function* validCertifiedReferencesSteps(
  action: ActionEnvelope,
  past: CertifiedPast,
): Work<boolean> {
  const own = new Map<number, Allocation>();
  for (const allocation of action.allocations) {
    yield;
    const id = allocation.id;
    if (
      id.birth.type !== 'action' ||
      actionKey(id.birth.action) !== actionKey(action.id) ||
      own.has(id.ordinal)
    )
      return false;
    own.set(id.ordinal, allocation);
  }
  const stack: unknown[] = [action.allocations, action.nativeManifest, action.effects];
  while (stack.length) {
    yield;
    const value = stack.pop();
    if (!value || typeof value !== 'object' || value instanceof Uint8Array) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        yield;
        stack.push(item);
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    if ('kind' in record && 'birth' in record && 'ordinal' in record) {
      const id = value as ResourceId<ResourceKind>;
      const allocation =
        id.birth.type === 'action' && actionKey(id.birth.action) === actionKey(action.id)
          ? own.get(id.ordinal)
          : past.allocation(id);
      if (allocation?.id.kind !== id.kind) return false;
    } else if ('actor' in record && 'sequence' in record) {
      if (!past.contains(value as ActionId)) return false;
    } else
      for (const item of Object.values(record)) {
        yield;
        stack.push(item);
      }
  }
  return true;
}
