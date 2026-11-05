# Independent replica experiment

Open two independent editors for the same document, edit while disconnected,
and deliver their work in either direction. Each editor keeps its own undo and
redo. Changing a sync mode keeps the engine and navigation history alive.

This is an **experimental reference-backed path** for grain/95 (MW-14). The
normal harness still uses schema 2. Normal cutover requires the accepted MW-13
incremental path and the remaining mounted acceptance matrix. This experiment
adds no production transport or account service. Yjs remains pinned to 13.6.33.

## Try the browser controls

Run `npm install` and `npm run dev`, then open `/multiwriter.html` on the displayed
local server. The web build includes that page as a separate entry.

1. Keep automatic delivery off. Edit A and B. Their views and histories differ.
2. Set A to **outbound-only**. Deliver A's messages to B. B receives A's work;
   A rejects B's incoming work and keeps its intentionally different view.
3. Duplicate, move, drop or deliver individual queue entries. **Retry A → peers**
   sends full held coverage, including prerequisites, without reverse receipts.
4. Enable receiving on A, then deliver catch-up messages. Undo and redo still
   target the initiating pane. The keyboard toolbar targets the last focused pane.
5. Use **Restart** on one pane. Its exact genesis and journal reopen; its local
   navigation resets. The other pane keeps its live engine and history.

All four modes allow local editing in this development host. Enabling sending
publishes accumulated held work. A message in the queue has been handed off;
it has no peer receipt. Applied and persisted status are separate. The page does
not claim global synchronization from a local counter or queue size.

**Export selected pane** captures Source and Tree from the named pane at its
local publication number. Source changes apply only through **New experiment
from Source**, which creates fresh genesis, journals, actors and history. Source
never replaces a live branch during synchronization. Old journals are retained.
Reloading the page reopens its saved experiment from IndexedDB.

## Open a headless editor

The host first installs the exact genesis bytes in durable metadata. Each
independent writer must use its own journal namespace, including writers with
the same account label. See [bootstrap setup](multiwriter-bootstrap.md) and
[provider persistence](../src/markdown/multiwriter/providers/README.md).

```ts
import { openReplica } from '../src/markdown/multiwriter/replica/index.js';
import { insertText } from '../src/markdown/multiwriter/authoring/index.js';

const replica = await openReplica({
  genesis, // exact bytes shared by all peers
  persistedGenesis: await metadata.read(documentId),
  journal: ownJournal,
  mode: 'disconnected',
});

const node = replica.publication().value.view.root.children[0];
const nodeId = replica.handle(node.origin.representative);
replica.edit(insertText, { nodeId, from: 0, text: 'Hello ' });
replica.undo();
replica.redo();
replica.setMode('outbound-only');
```

The example assumes the first child is editable. General callers walk the
projection to find a node with text boundaries. Resolve command handles just
before dispatch; never retain `construction:*` handles across publications.
For an empty document, call `editEmptyRoot(text)`. Rendering an empty-root caret
does not author a paragraph or history entry.

`edit()` uses the same semantic commands and managed history as the browser.
Pass `selectionBefore`, `hostRoot` and `scopeRoot` independently where needed.
`typing: true` permits contiguous `insertText` coalescing. Other commands are
isolated. Call `sealGroup()` when native selection, focus or host changes.

## Deliver and resume

Attach host transports with `attachPeer()`. Send every remote update through
`receive(route, bytes)` and every bootstrap bundle tail through `receiveBundle()`.
The `peer`, `catch-up`, `self-echo` and `cross-tab` routes share provider admission.
Do not import updates directly into storage while the provider is attached.

`ReplicaNetwork` in `replica/network.ts` is the development scheduler used by
the page and headless tests. Register instances with `add()`, connect directed
links with `connect()`, and control opaque messages with `queue()`, `deliver()`,
`duplicate()`, `move()`, `drop()` and `retry()`. `setAutomatic(true)` drains them.
Queue snapshots contain detached copies of original carrier bytes. A disabled
receive consumes its delivery; there is no hidden remote inbox. Retry requests
fresh full sender coverage. Do not share a journal to simulate delivery.

The facade refreshes after all admitted receives, including unresolved carrier
updates that produce no action-store event. A deferred publication retains the
last complete view and blocks authoring. Call `retryPublication(operations)` to
resume it. `setNativeDecodeLimit()` and `setProviderLimits()` adjust existing
capacity controls; they do not replace the replica or discard held facts.

Subscribe to publication/history/mode/lifecycle events with `subscribe()`.
Observers cannot reenter mutations or abort canonical append. `status()` reports
observer errors, local edit/control counts, history and authoring availability.
`publication()` keeps the tree, native view and addresses together. Use current
publications; their native view is not a durable snapshot.

An admitted receive can throw during publication after retaining its bytes.
Retry publication separately. A `RetainedEditError` means the exact local edit or
control is already retained. Do not repeat the command. Recover publication and
selection with `retainedRestoration(error.action)`, then continue editing. That
restoration uses the exact staged history selection; it does not recapture
numeric command offsets after a peer refresh. Persistence retry never repeats input.

## Persistence and close

`capturePersistence().status()` reports the captured local publication's durable
status. `flush()` waits for a captured journal prefix. Neither proves delivery.

Call `close()` before releasing a host binding. Close immediately fences edits,
undo/redo, mode changes and remote ingress, then stops provider callbacks and
flushes persistence. Failed persistence leaves the same engine and queued bytes
available, with mutations still fenced. Fix storage, call `retryPersistence()`,
then call `close()` again. Do not resume editing that closing instance. Reopen its
own namespace to start a fresh actor with empty local navigation.

## Integration boundaries

`md-multiwriter-editor` takes one `Replica`. Its origin-keyed renderer facade
preserves unaffected nodes and DOM through publications. Constituents resolve
through current representative aliases; they are not command handles. Native
selection uses MW-10 stable points. A collapsed native caret uses one affinity
for both endpoints, following adjacent text at inline edges. Explicit headless
caller affinities are preserved by MW-10.

Selection and composition controllers take adapter operations for node lookup,
anchor capture/resolution and lifecycle checks. Schema-2 editing continues to use
the same controllers through its canonical adapter. Composition still validates
the complete payload and UTF-16 envelope, remounts damaged inlines through their
blocks, and replays queued input once. Deleted mutation targets remain invalid;
caret fallback is a separate operation. Focus guards and publication generations
cancel stale async focus work.

The experimental page owns immutable genesis metadata in `grain-mw14-host` and
separate `grain-actionDoc:mw14:<experiment>:<pane>` IndexedDB databases. It adds no
BroadcastChannel path or foreign-journal discovery.

The compatibility crosswalk is in [legacy-test-crosswalk.md](legacy-test-crosswalk.md).
Chromium desktop automation does not prove physical Android, iOS or IME behavior.
The reference path still reconstructs state and is not ordinary-input performance
acceptance. Normal harness cutover, complete mobile caret/keyboard geometry and
the final MW-16 gate remain separate from these experimental checks.
