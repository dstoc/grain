# Edit authoring

An edit command changes the document through a scoped `CommandDraft`. The canonical editor's session runner applies the command, validates and normalizes the result, and owns publication, undo/redo, focus, selection, and session attribution.

## Add or change a command

1. Define a typed input and implement `Edit<Input>` from `src/editing/outcomes.ts`.
2. Read and change nodes through `context.draft`. Use `context.scopeRoot` and `assertScopedTarget()` before editing a target.
3. Validate text ranges with `assertTextRange()` from `src/markdown/semantic/types.ts`. Use the helpers in `src/editing/operations/` for shared tree operations.
4. Return `handled()` with a `TextPoint` focus or a `SelectionIntent` when the command needs to set selection. Return `NOT_APPLICABLE` only when the command did not handle the input.
5. Route browser commands through the canonical editor's session runner. Do not call the canonical writer from the command.
6. Add command tests for the tree result and scope rejection. Add editor tests when the change affects visible output, focus, selection, or history.

`EditContext` supplies the draft, a required scope root, and the selection before the command. A command may read and mutate only nodes inside that scope. The session runner validates the final structure before accepting it.

## Existing examples

- `src/editing/commands/insert-line-break.ts` validates a text range, splits inline content through shared operations, and returns a focus point.
- `src/editing/commands/indent.ts` and `outdent.ts` handle structural moves and selected nodes within the scope.
- `src/editing/commands/cycle-task-state.ts` changes task state through the draft; the renderer emits an intent and the host invokes it through the session.

## Command boundaries

- Do not import Yjs, canonical implementation modules, DOM globals, or renderer elements into semantic commands or operations.
- Do not mutate rendered DOM to express document changes.
- Do not parse or rebuild the whole document for an ordinary edit. Use the draft operations and preserve unaffected node identity.
- Do not commit directly from a renderer event. Send a typed intent to the host so the active session owns the edit.
- Keep command-specific intent in the command. Put document-wide invariants in normalization or validation.

Run the focused command tests while developing. For changes to editor behavior, include browser checks for visible output and relevant focus, selection, undo, and redo behavior. The project verification commands are listed in `package.json` and `docs/legacy-retirement.md`.

## Headless multiwriter authoring

`src/markdown/multiwriter/authoring/index.ts` exports `LocalEditor` and the existing
semantic commands. Open each independent replica with `openReferenceDocument()`
and the same exact `ReferenceGenesis`. Give each replica its own `LocalEditor`.
After opening, call `editor.refresh()` before editing.

```ts
const editor = new LocalEditor(document, genesis);
editor.refresh();
const nodeId = editor.handle(inline.origin.representative);
const result = editor.edit({ local: 'pane', group: 1n }, insertText, {
  nodeId,
  from: 0,
  text: 'hello',
});
```

Resolve `inline` from that replica's current published view. Handles belong to the
current projection; obtain them again after an edit or remote publication. Pass a
`scopeRoot` handle in the fourth argument to restrict a command. Group IDs belong
to the local session; history navigation and grouping policy remain MW-10 work.

An edit publishes synchronously before the next call. It does not wait for
persistence or network acknowledgments. `applied` identifies the retained action,
its exact allocation/effect footprint and stable focus/selection origins. Use the
provider's publication status for persistence and delivery. A handled no-op returns
`unchanged` and authors no action. A declined conversion authors no facts.

Commands must distinguish `splitInline`, `joinInline`, `deleteSubtree` and
`liftChildren`. A join retains its source flow; lifting retains empty raw wrappers.
Only explicit deletion adds subtree deletion tags. Use fragment transfer for a
move of existing text and ordinary creation for clipboard copies.

Use `{ promote: nodeId }` for optional promotion after literal input, or
`{ conversion: { nodeId, plan } }` for an explicit terminal parser conversion.
`interpretMarkdown(context, nodeId, plan)` composes conversion with later commands
inside one edit and returns output handles in parser preorder, including wrappers.
Its retained pieces keep native identities. Synthesis gets fresh native identities.
Conversion-specific transfers and properties belong to the interpretation packet;
independent task edits and transfers keep their own activity when that packet loses.
Unsupported retained-piece ordering declines explicitly. Invalid optional promotion
keeps the literal edit. Operational errors propagate.

Before append, failure aborts native preparation and preserves canonical facts.
`RetainedEditError` means append already succeeded: refresh publication and retry
persistence rather than authoring the command again. Close the editor with
`destroy()` when its writer instance ends.

This headless implementation uses the full reference reducer. It supplies command
and replay correctness controls, not MW-13 performance acceptance or browser
cutover. The canonical browser runner remains active. MW-10 navigation and
MW-16 browser/IME acceptance remain separate gates.
