import type { CommandReplica } from './replica.js';
import type { LocalEditResult } from '../../../src/markdown/multiwriter/authoring/editor.js';
import type { ActionEnvelope, ActionId } from '../../../src/markdown/multiwriter/contracts.js';

export function control(
  peer: CommandReplica,
  result: LocalEditResult,
  active: boolean,
  previous: ActionId | null = null,
): ActionId {
  if (result.status !== 'applied') throw new Error('Missing compiler action');
  const ready = peer.document.store.snapshot().ready,
    actor = result.action.actor;
  const sequence =
    ready
      .filter((a) => a.id.actor === actor)
      .reduce((n, a) => (a.id.sequence > n ? a.id.sequence : n), 0n) + 1n;
  const action: ActionEnvelope = {
    protocolVersion: 3,
    documentId: 'D',
    genesisId: 'G',
    id: { actor, sequence },
    lamport: ready.reduce((n, a) => (a.lamport > n ? a.lamport : n), 0n) + 1n,
    dependencies: [
      ...new Map(
        [
          ...peer.document.publication.status().publication!.heads,
          { actor, sequence: sequence - 1n },
        ].map((id) => [`${id.actor}:${id.sequence}`, id]),
      ).values(),
    ],
    groupId: { session: result.group.session, sequence: 10000n + sequence },
    allocations: [],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects: [
      {
        type: 'SetGroupActive',
        group: result.group,
        actions: [result.action],
        active,
        previousControl: previous,
      },
    ],
  };
  peer.document.certifyLocal(action);
  peer.document.store.append(action);
  peer.editor.refresh();
  return action.id;
}
