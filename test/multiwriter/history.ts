import { afterEach } from 'vitest';
import { commandGenesis, commandReplica } from './commands/replica.js';
import type { CommandReplica } from './commands/replica.js';
import type { Affinity } from '../../src/markdown/multiwriter/contracts.js';
import { insertText } from '../../src/editing/commands/insert-text.js';
import type { ManagedEditOptions } from '../../src/markdown/multiwriter/history/session.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
export function replica(
  markdown = 'abcdef',
  genesis = commandGenesis(markdown),
  bytes?: Uint8Array,
) {
  const peer = commandReplica(genesis, bytes);
  cleanups.push(() => peer.close());
  return peer;
}
export function cleanup(close: () => void | Promise<void>) {
  cleanups.push(close);
}
export function selection(
  peer: CommandReplica,
  index: number,
  from: number,
  to = from,
  affinity: Affinity = 'right',
) {
  const nodeId = peer.handle(peer.nodes()[index]!);
  return { anchor: { nodeId, offset: from, affinity }, focus: { nodeId, offset: to, affinity } };
}
export function type(
  peer: CommandReplica,
  text: string,
  at = peer.nodes()[0]!.content.length,
  options: ManagedEditOptions = {},
  local = 'default',
) {
  return peer.editor
    .session(local)
    .edit(
      insertText,
      { nodeId: peer.handle(peer.nodes()[0]!), from: at, text },
      { selectionBefore: selection(peer, 0, at), ...options },
    );
}
