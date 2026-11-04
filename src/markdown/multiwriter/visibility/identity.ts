import type { ActionId, GroupId, ResourceId, ResourceKind, SessionId } from '../contracts.js';

export function actionKey(id: ActionId): string {
  return `${id.actor}:${id.sequence}`;
}

function sessionKey(id: SessionId): string {
  return JSON.stringify([id.actor, id.local]);
}

export function groupKey(id: GroupId): string {
  return `${sessionKey(id.session)}:${id.sequence}`;
}

export function resourceKey(id: ResourceId<ResourceKind>): string {
  const birth =
    id.birth.type === 'genesis'
      ? ['genesis', id.birth.genesisId]
      : ['action', actionKey(id.birth.action)];
  return JSON.stringify([id.kind, birth, id.ordinal]);
}
