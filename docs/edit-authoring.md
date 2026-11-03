# Edit authoring

An edit command changes the document through a scoped `TreeDraft`. The canonical editor's session runner applies the command, validates and normalizes the result, and owns publication, undo/redo, focus, selection, and session attribution.

## Add or change a command

1. Define a typed input and implement `Edit<Input>` from `src/editing/outcomes.ts`.
2. Read and change nodes through `context.draft`. Use `context.scopeRoot` and `assertScopedTarget()` before editing a target.
3. Validate text ranges with `assertTextRange()` from `src/markdown/semantic/types.ts`. Use the helpers in `src/editing/operations/` for shared tree operations.
4. Return `handled()` with a `TextPoint` focus or a `SelectionIntent` when the command needs to set selection. Return `NOT_APPLICABLE` only when the command did not handle the input.
5. Route the command through the canonical editor's session runner. Do not call the canonical writer from the command.
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
