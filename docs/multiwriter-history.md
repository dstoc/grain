# Per-instance history

Each `LocalEditor` owns independent, bounded undo/redo stacks for its local
sessions. Undo and redo append replicated `SetGroupActive` controls. Receiving an
edit or control never creates a navigation entry or clears local redo. Account
identity has no role in session ownership.

Use the headless [authoring API](../src/markdown/multiwriter/authoring/index.ts)
and [history API](../src/markdown/multiwriter/history/index.ts) with an open,
refreshed reference document. Keep the same editor and session while changing
provider modes or reconnecting.

```ts
const editor = new LocalEditor(document, genesis);
const history = editor.session(); // repeated admission returns the same facade
const nodeId = editor.handle(currentInline.origin.representative);

history.edit(
  insertText,
  { nodeId, from: 2, text: 'hello' },
  {
    selectionBefore: {
      anchor: { nodeId, offset: 2, affinity: 'right' },
      focus: { nodeId, offset: 2, affinity: 'right' },
    },
  },
);
const result = history.undo();
if (result.state === 'applied') {
  // Inspect result.restoration; a later browser adapter must revalidate
  // result.version and result.session before applying focus after render waits.
}
history.redo();
```

`editor.session('another-view')` opens an independent local stack on that editor.
Separate editors always have separate actors and stacks. A session identity used
by managed history cannot also be passed to low-level `editor.edit()`, including
after reset. Low-level sessions cannot later be adopted into managed history.
Low-level edits remain available to existing callers but do not populate these
stacks.

## Groups and limits

Commands, replacement, paste and composition commits are isolated by default.
Opt into literal typing groups with `typing: true` on `insertText` and supply a
collapsed `selectionBefore`. Adjacent inputs coalesce only in the same retained
inline lineage, at the restored previous caret, within 1,000 ms. A replacement
range forms its own group. An optional `promote` keeps input and Markdown
promotion together and seals the group after successful promotion. An optional
promotion that declines retains the literal input. Explicit conversion that
declines, no-ops and inapplicable commands create no entry and preserve redo.

Call `sealGroup()` on selection movement, focus or host changes and other explicit
boundaries. Structural commands, undo and redo seal automatically. Remote changes
can prevent continuity; they do not clear redo. Composition callers commit once
without the typing opt-in.

The default limit is 500 groups across undo and redo together. Configure a session
on first admission with `editor.session(name, { limit, clock })`; `clock` is a local
millisecond clock for grouping. `setLimit()` accepts a nonnegative safe integer,
including zero, and evicts the oldest groups by their original local order.
`reset()` discards only that session's navigation metadata. Neither operation
writes controls or removes canonical facts. Group counters are never reused.
`groups()` returns detached diagnostics.

`status()` reports counts, availability, limit and `reset`. A new or explicitly
reset session reports `reset: true` until an applied edit/control. Restart restores
canonical actions through the existing bootstrap/provider paths, then opens a new
editor with empty/reset history. It does not reconstruct a previous cursor.

## Scoped undo and caret restoration

Pass `{ scope: currentViewNode.origin }` to undo/redo to filter by the current
projection scope. A normalized wrapper includes all its constituent origins and
projected descendants. History can skip wholly outside groups; the first mixed
or unresolved footprint blocks the request. It never splits a group. Hidden and
inactive content remains classifiable through retained ownership and placement.
A selected group consumes one navigation step even when another deletion or move
makes its control have no visible effect.

Navigation returns `empty`, `invalid-scope`, `blocked`, or `applied`. A blocked
result includes `mixed-footprint` or `unresolved-footprint` and the selected group.
Rejected requests leave stacks and canonical bytes unchanged.

Selections retain both native gap neighbors, caller affinities, directional block
endpoints, raw placement and host origins. `LocalEditOptions.hostRoot` identifies
the initiating host independently of `scopeRoot`, which restricts the command.
Both default to the document root. For a nested host, pass its current origin as
`{ host }` to undo/redo. A different or deleted host refuses restoration.

An applied control returns an independent restoration result: `exact`, `fallback`,
`empty-root`, or `unavailable`. A partial range collapses to its saved focus. If
that focus is gone, fallback searches current retained inline order inside the
host, counts hidden records, prefers the nearer candidate and chooses the
predecessor on a tie. A focus moved outside the host uses its captured occurrence
as a gap. A predecessor receives an end caret with left affinity; a successor
receives a start caret with right affinity. An empty document can use its existing
local empty-root view. Resolution creates no canonical paragraph or marker.

The exported `capturePoint()` and `resolveSelection()` provide the same pure
headless resolution contract. Fallback does not make a deleted mutation address
available. Capture a new address before editing at the returned caret. Remote
updates alone never request focus restoration.

## Failures and persistence

Before append, failures leave the cursor and canonical state unchanged. Once the
exact envelope is retained, its edit or control registers exactly once, even if
an observer or refresh fails. `RetainedEditError` carries `appended: true` and the
retained action ID. Refresh with `editor.refresh()` before further work. Do not
repeat that semantic edit or undo: the edit is already grouped or the cursor has
already moved. After-selections are staged against the exact author result before
append, so intervening peer changes cannot turn recovery into offset recapture.

Provider persistence errors report unsaved state. They do not roll back history.
Use the provider's existing persistence retry; retry does not append another
semantic action. All remote routes must enter the attached provider's `receive()`.

This implementation uses the full reference reducer, including an author-result
projection for command focus capture. Browser mounting, render-wait focus guards,
physical IME checks and performance acceptance remain later integration gates.
It introduces no native UndoManager or wire-format change. Lossless checkpoint
integration requires MW-18; navigation metadata stays owned by the live editor.
