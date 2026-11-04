import { actorId } from '../../src/markdown/multiwriter/contracts.js';
import type { ActionEnvelope } from '../../src/markdown/multiwriter/contracts.js';
import { NativeTapeCache } from '../../src/markdown/multiwriter/text/cache.js';
import { openReferenceDocument } from '../../src/markdown/multiwriter/reference/document.js';
import type { ReferenceGenesis } from '../../src/markdown/multiwriter/reference/document.js';
import { CellIndex, HomeIndex } from '../../src/markdown/multiwriter/ownership/index.js';

export function publication(document: ReturnType<typeof openReferenceDocument>) {
  let result = document.publication.refresh();
  while (result.state === 'deferred') result = result.continuation.resume();
  return result.value;
}
export function insert(
  genesis: ReferenceGenesis,
  letter: string,
  actorNumber: number,
): ActionEnvelope {
  const native = new NativeTapeCache();
  native.apply('genesis', genesis.body);
  const document = openReferenceDocument(genesis);
  try {
    const p = publication(document),
      ownership = p.value.ownership;
    const home = ownership.homeBindings[0];
    const actor = actorId(actorNumber.toString(16).padStart(32, '0'));
    const actionId = { actor, sequence: 1n };
    let ordinal = 0;
    const operations = new HomeIndex(
      ownership.homeBindings,
      new CellIndex(ownership.homeBindings.map((h) => native.snapshot(h.cell.tape))),
    ).planTextInsertion(
      { run: home.run, boundary: home.cell.end, side: 'left', predecessor: null },
      letter,
      () => ({ kind: 'marker', ordinal: ordinal++, birth: { type: 'action', action: actionId } }),
    );
    const prepared = native.prepare('edit', operations);
    const action: ActionEnvelope = {
      protocolVersion: 3,
      documentId: genesis.documentId,
      genesisId: genesis.genesisId,
      id: actionId,
      dependencies: [],
      lamport: 1n,
      groupId: { session: { actor, local: 'review' }, sequence: 1n },
      ...prepared.body,
      effects: [
        {
          type: 'InsertText',
          ranges: prepared.body.nativeManifest.flatMap((entry) =>
            entry.type === 'text' ? [{ tape: entry.tape, ...entry.native }] : [],
          ),
        },
      ],
    };
    document.certifyLocal(action);
    prepared.commit();
    return action;
  } finally {
    document.destroy();
    native.destroy();
  }
}
