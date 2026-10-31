// Copyright 2022 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import '../markdown/block-render.js';

import { assert, cast } from '../asserts.js';
import { css, html, LitElement } from 'lit';
import { property, customElement, query } from 'lit/decorators.js';
import { MarkdownRenderer } from '../markdown/block-render.js';
import { HostContext, focusNode } from '../markdown/host-context.js';
import type { MarkdownRenderDelegate } from '../markdown/render-delegate.js';
import {
  MarkdownInline,
  InlineInput,
  InlineKeyDown,
  InlineLinkClick,
  InlineProjectionSelection,
} from '../markdown/inline-render.js';
import {
  findNextEditable,
  findPreviousEditable,
  isAncestorOf,
} from '../markdown/view-model-util.js';
import { ViewModelNode, InlineViewModelNode, viewModel } from '../markdown/view-model-node.js';
import { getContainingTransclusion } from '../markdown/transclusion.js';
import { expandSelection, getBlockSelectionTarget } from './block-selection-util.js';
import { noAwait } from '../async.js';
import { editBlockSelectionIndent } from './edits/indent-block-selection.js';
import { editInlineIndent } from './edits/indent-inline.js';
import { removeSelectedNodes } from './edits/remove-selected-nodes.js';
import { editInlineNode } from './edits/edit-inline-node.js';
import { insertLineBreak, insertParagraph } from './edits/insert-paragraph.js';
import { deleteContentBackwards } from './edits/delete-content-backwards.js';
import { insertMarkdown, serializeSelection } from './copy-paste-util.js';
import { Focus } from '../markdown/view-model-ops.js';
import { NodeSignalController } from '../markdown/node-signal-controller.js';
import { normalizeKeys } from './keyboard.js';

type ExcludeFirst<T extends Parameters<any>> = T extends [any, ...infer Rest] ? Rest : never;

// Native selections can cover the inline while shadow-root offsets omit a final newline.
// Only use composed ranges when the rendered text and ownership can be established.
function hasCompleteCodeSelection(
  editor: Editor,
  inline: MarkdownInline,
  node: InlineViewModelNode,
) {
  try {
    const context = inline.hostContext;
    if (
      !inline.isConnected ||
      !!inline.shadowRoot ||
      inline.node !== node ||
      node.type !== 'code-block' ||
      !node.content ||
      !context?.root ||
      !(node === context.root || isAncestorOf(context.root, node))
    )
      return false;

    const roots: ShadowRoot[] = [];
    let current: Node = inline;
    let belongsToEditor = false;
    while (true) {
      const root = current.getRootNode();
      if (root instanceof Document) {
        if (root !== inline.ownerDocument || (current === inline && root.activeElement !== inline))
          return false;
        break;
      }
      if (!(root instanceof ShadowRoot)) return false;
      if (current === inline && root.activeElement !== inline) return false;
      roots.push(root);
      if (root.host === editor) belongsToEditor = true;
      current = root.host;
    }
    if (!belongsToEditor) return false;

    const texts: Text[] = [];
    const inspect = (parent: Node): boolean => {
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) texts.push(child as Text);
        else if (child.nodeType === Node.COMMENT_NODE) continue;
        else if (
          child instanceof HTMLElement &&
          child.localName === 'md-span' &&
          !child.shadowRoot
        ) {
          if (!inspect(child)) return false;
        } else return false;
      }
      return true;
    };
    if (!inspect(inline) || texts.map((text) => text.data).join('') !== node.content) return false;
    const nonempty = texts.filter((text) => text.length);
    const first = nonempty[0];
    const last = nonempty.at(-1);
    if (!first || !last) return false;

    const selection = inline.ownerDocument.getSelection();
    if (!selection || typeof selection.getComposedRanges !== 'function') return false;
    const ranges = selection.getComposedRanges({ shadowRoots: roots });
    if (ranges.length !== 1 || ranges[0].collapsed) return false;
    const composed = ranges[0];
    if (!inline.contains(composed.startContainer) || !inline.contains(composed.endContainer))
      return false;
    const range = inline.ownerDocument.createRange();
    range.setStart(composed.startContainer, composed.startOffset);
    range.setEnd(composed.endContainer, composed.endOffset);
    return range.comparePoint(first, 0) !== -1 && range.comparePoint(last, last.length) !== 1;
  } catch {
    return false;
  }
}

export interface EditContext {
  // TODO: maybe change the API so that the other functions are
  // available as a result of calling startEditing...
  startEditing(): void;
  keepFocus(): void;
  focus(node: ViewModelNode, offset: number): void;
  clearSelection(): void;
  setSelection(nodes: Iterable<InlineViewModelNode>): void;
  readonly selection: Iterable<ViewModelNode>;
  readonly node: ViewModelNode;
  readonly root: ViewModelNode;
}

interface CompositionPendingInput {
  start: number;
  end: number;
  before: string;
  inputType: string;
}

interface CompositionSession {
  inline: MarkdownInline;
  node: InlineViewModelNode;
  content: string;
  version: number;
  start: number;
  end: number;
  anchor: number;
  focus: number;
  tree: InlineViewModelNode[typeof viewModel]['tree'];
  currentText: string;
  replacementStart: number;
  replacementEnd: number;
  replacementText: string;
  pending?: CompositionPendingInput;
  invalid: boolean;
  invalidate: (event?: Event) => void;
  beforeInput: (event: Event) => void;
  input: (event: Event) => void;
}

@customElement('md-editor')
export class Editor extends LitElement {
  private composition?: CompositionSession;
  private compositionFocus?: Focus;
  defaultName?: string;
  @property({ type: String, reflect: true })
  accessor status: 'loading' | 'loaded' | 'error' | undefined;
  @property({ attribute: false }) accessor root: ViewModelNode | undefined;
  private nodeSignal = new NodeSignalController(this, () => this.root);
  @property({ attribute: false })
  accessor renderDelegate: MarkdownRenderDelegate | undefined;
  @query('md-block-render')
  private accessor markdownRenderer!: MarkdownRenderer;
  static override get styles() {
    return [
      css`
        #status {
          position: absolute;
        }
        pkm-title {
          display: block;
          position: sticky;
          top: 0;
          padding-bottom: 0.5em;
          background: var(--root-background-color);
        }
        pkm-title:empty {
          padding-bottom: 0em;
        }
      `,
    ];
  }
  override render() {
    return html` <pkm-title .node=${this.root}></pkm-title>
      <md-block-render
        .block=${this.root}
        .renderDelegate=${this.renderDelegate}
        @inline-input=${(e: CustomEvent<InlineInput>) => this.onInlineInput(e)}
        @inline-link-click=${(e: CustomEvent<InlineLinkClick>) => this.onInlineLinkClick(e)}
        @inline-keydown=${(e: CustomEvent<InlineKeyDown>) => this.onInlineKeyDown(e)}
        @inline-composition-start=${(e: CustomEvent<{ inline: MarkdownInline }>) => this.startComposition(e.detail.inline)}
        @inline-composition-end=${(
          e: CustomEvent<{ inline: MarkdownInline; event: CompositionEvent }>,
        ) =>
          noAwait(
            this.endComposition(e.detail.inline, e.detail.event).catch((error: unknown) =>
              console.error('Composition completion failed:', error),
            ),
          )}
        @copy=${(e: ClipboardEvent) => this.onClipboard(e)}
        @cut=${(e: ClipboardEvent) => this.onClipboard(e)}
        @paste=${(e: ClipboardEvent) => this.onPaste(e)}
      ></md-block-render>`;
  }

  private clearComposition(restore: boolean) {
    const session = this.composition;
    if (!session) return;
    this.composition = undefined;
    session.tree.removeEventListener('tree-change', session.invalidate);
    session.inline.removeEventListener('composition-invalidated', session.invalidate);
    session.inline.removeEventListener('beforeinput', session.beforeInput, true);
    session.inline.removeEventListener('input', session.input, true);
    session.inline.composing = false;
    if (restore && session.inline.isConnected) {
      const selection = this.currentCompositionSelection(session);
      noAwait(session.inline.recoverComposition(selection));
    }
  }

  private startComposition(inline: MarkdownInline) {
    this.clearComposition(true);
    inline.composing = true;
    const node = inline.node;
    const selection = inline.getTextSelection();
    if (
      !node ||
      !selection ||
      !inline.isConnected ||
      !node[viewModel].connected ||
      inline.textContent !== node.content
    ) {
      return;
    }
    const tree = node[viewModel].tree;
    const start = Math.min(selection.anchor, selection.focus);
    const end = Math.max(selection.anchor, selection.focus);
    const session = {
      inline,
      node,
      tree,
      content: node.content,
      version: node[viewModel].version,
      start,
      end,
      anchor: selection.anchor,
      focus: selection.focus,
      currentText: node.content,
      replacementStart: start,
      replacementEnd: end,
      replacementText: node.content.slice(start, end),
      invalid: false,
      invalidate: () => {},
      beforeInput: (event: Event) => this.beforeCompositionInput(session, event as InputEvent),
      input: (event: Event) => this.afterCompositionInput(session, event as InputEvent),
    };
    session.invalidate = (event?: Event) => {
      if (event instanceof CustomEvent && event.detail === 'cache') return;
      if (this.composition === session) this.clearComposition(true);
    };
    this.composition = session;
    tree.addEventListener('tree-change', session.invalidate);
    inline.addEventListener('composition-invalidated', session.invalidate);
    inline.addEventListener('beforeinput', session.beforeInput, true);
    inline.addEventListener('input', session.input, true);
  }

  private async endComposition(inline: MarkdownInline, event: CompositionEvent) {
    const session = this.composition;
    if (!session || session.inline !== inline) {
      inline.composing = false;
      if (inline.isConnected) {
        noAwait(inline.recoverComposition(inline.getTextSelection() ?? { anchor: 0, focus: 0 }));
      }
      return;
    }
    this.clearComposition(false);
    const { node, content, version } = session;
    if (
      !inline.isConnected ||
      inline.node !== node ||
      !node[viewModel].connected ||
      node[viewModel].version !== version ||
      node.content !== content
    ) {
      if (inline.isConnected) {
        noAwait(inline.recoverComposition(this.currentCompositionSelection(session)));
      }
      return;
    }
    const selection = { anchor: session.anchor, focus: session.focus };
    const expectedText =
      content.slice(0, session.replacementStart) +
      session.replacementText +
      content.slice(session.replacementEnd);
    if (
      !event.data ||
      session.invalid ||
      inline.textContent !== session.currentText ||
      session.currentText !== expectedText ||
      session.replacementText.length === 0 ||
      content.slice(session.replacementStart, session.replacementEnd) === session.replacementText
    ) {
      noAwait(inline.recoverComposition(selection));
      return;
    }
    const start = session.replacementStart;
    const end = session.replacementEnd;
    const newText = session.replacementText;
    this.compositionFocus = { node, offset: start };
    try {
      await inline.recoverComposition(selection, false);
      const target = this.inlineForNode(node);
      if (
        !target ||
        !target.isConnected ||
        !node[viewModel].connected ||
        node[viewModel].version !== version ||
        node.content !== content
      ) {
        if (target?.isConnected) {
          noAwait(target.recoverComposition({ anchor: 0, focus: 0 }));
        }
        return;
      }
      this.runEditAction(target, editInlineNode, {
        startIndex: start,
        oldEndIndex: end,
        newText,
        newEndIndex: start + newText.length,
      });
      const caret = start + newText.length;
      noAwait(target.recoverComposition({ anchor: caret, focus: caret }));
    } finally {
      this.compositionFocus = undefined;
    }
  }

  private inlineForNode(node: InlineViewModelNode) {
    const inlines = [
      ...this.markdownRenderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ].filter((inline) => inline.node === node);
    return inlines.find((inline) => inline.matches(':focus-within')) ?? inlines[0];
  }

  private currentCompositionSelection(session: CompositionSession): InlineProjectionSelection {
    if (
      session.node[viewModel].connected &&
      session.inline.node === session.node &&
      session.node[viewModel].tree === session.tree
    ) {
      if (
        session.node[viewModel].version !== session.version ||
        session.node.content !== session.content
      ) {
        return { anchor: 0, focus: 0 };
      }
      return { anchor: session.anchor, focus: session.focus };
    }
    if (session.inline.node && session.inline.node[viewModel].connected) {
      const offset = Math.max(0, Math.min(session.start, session.inline.node.content.length));
      return { anchor: offset, focus: offset };
    }
    return { anchor: 0, focus: 0 };
  }

  private beforeCompositionInput(session: CompositionSession, event: InputEvent) {
    if (!this.isCompositionInput(event) || this.composition !== session) return;
    if (session.invalid) return;
    if (session.pending && session.inline.textContent !== session.pending.before) {
      session.invalid = true;
      return;
    }
    const before = session.inline.textContent ?? '';
    if (before !== session.currentText) {
      session.invalid = true;
      return;
    }
    const range = this.compositionInputRange(session.inline, event);
    if (!range || range.start < 0 || range.end < range.start || range.end > before.length) {
      session.invalid = true;
      return;
    }
    session.pending = {
      start: range.start,
      end: range.end,
      before,
      inputType: event.inputType,
    };
  }

  private afterCompositionInput(session: CompositionSession, event: InputEvent) {
    if (!this.isCompositionInput(event) || this.composition !== session) return;
    const pending = session.pending;
    session.pending = undefined;
    if (session.invalid) return;
    if (
      !pending ||
      pending.inputType !== event.inputType ||
      pending.before !== session.currentText
    ) {
      session.invalid = true;
      return;
    }
    const after = session.inline.textContent ?? '';
    const { start, end } = pending;
    const insertedLength = after.length - (pending.before.length - (end - start));
    if (
      insertedLength < 0 ||
      pending.before.slice(0, start) !== after.slice(0, start) ||
      pending.before.slice(end) !== after.slice(start + insertedLength)
    ) {
      session.invalid = true;
      return;
    }

    const currentStart = session.replacementStart;
    const currentEnd = currentStart + session.replacementText.length;
    if (end < currentStart || start > currentEnd) {
      session.invalid = true;
      return;
    }
    const nextStart = Math.min(currentStart, start);
    const rightExtension = Math.max(0, end - currentEnd);
    const expandedText =
      pending.before.slice(nextStart, currentStart) +
      session.replacementText +
      pending.before.slice(currentEnd, currentEnd + rightExtension);
    const localStart = start - nextStart;
    const localEnd = end - nextStart;
    const inserted = after.slice(start, start + insertedLength);
    const replacementText =
      expandedText.slice(0, localStart) + inserted + expandedText.slice(localEnd);
    const replacementStart = nextStart;
    const replacementEnd = session.replacementEnd + rightExtension;
    const expectedAfter =
      session.content.slice(0, replacementStart) +
      replacementText +
      session.content.slice(replacementEnd);
    if (after !== expectedAfter) {
      session.invalid = true;
      return;
    }
    session.replacementStart = replacementStart;
    session.replacementEnd = replacementEnd;
    session.replacementText = replacementText;
    session.currentText = after;
  }

  private compositionInputRange(
    inline: MarkdownInline,
    event: InputEvent,
  ): { start: number; end: number } | undefined {
    try {
      const ranges = event.getTargetRanges();
      if (ranges.length === 1) {
        const range = ranges[0]!;
        const start = inline.textOffset(range.startContainer, range.startOffset);
        const end = inline.textOffset(range.endContainer, range.endOffset);
        if (start !== undefined && end !== undefined && start <= end) return { start, end };
      }
    } catch {
      // Some input implementations do not expose target ranges.
    }
    const selection = inline.getTextSelection();
    if (!selection) return;
    return {
      start: Math.min(selection.anchor, selection.focus),
      end: Math.max(selection.anchor, selection.focus),
    };
  }

  private isCompositionInput(event: InputEvent) {
    return event.inputType === 'insertCompositionText' || event.isComposing;
  }

  override disconnectedCallback() {
    this.clearComposition(false);
    super.disconnectedCallback();
  }

  runEditAction<
    T extends (state: EditContext, ...args: ExcludeFirst<Parameters<T>>) => ReturnType<T>,
  >(
    element: Element & { hostContext?: HostContext; node?: ViewModelNode },
    action: T,
    ...args: ExcludeFirst<Parameters<T>>
  ): ReturnType<T> {
    const hostContext = cast(element.hostContext);
    const renderer = this.markdownRenderer;
    let endFocus: Focus | undefined;
    let startFocus: Focus | undefined;
    const compositionFocus = this.compositionFocus;
    const context: EditContext = {
      get root() {
        return cast(hostContext.root);
      },
      get node() {
        return cast(element.node);
      },
      focus(node: InlineViewModelNode, offset: number) {
        endFocus = { node, offset };
      },
      startEditing() {
        if (compositionFocus) {
          startFocus = compositionFocus;
        } else if (element instanceof MarkdownInline) {
          const selection = element.getSelection();
          if (selection) {
            startFocus = { node: element.node!, offset: selection.start.index };
          }
        }
        if (!startFocus) {
          const { inline, startIndex } = renderer.getInlineSelection();
          if (inline?.node) {
            startFocus = { node: inline.node, offset: startIndex! };
          }
        }
        if (hostContext.hasSelection) {
          startFocus ??= {
            node: hostContext.selectionFocus!,
            offset: 0,
          };
          startFocus.selection = [...hostContext.selection];
        }
      },
      keepFocus() {
        if (hostContext.selectionFocus) {
          this.focus(hostContext.selectionFocus, 0);
        } else if (element instanceof MarkdownInline) {
          const selection = element.getSelection();
          const offset = selection?.start.index ?? 0;
          this.focus(this.node, offset);
        } else {
          const { inline, startIndex } = renderer.getInlineSelection();
          if (inline?.node) {
            this.focus(inline.node, startIndex!);
          }
        }
      },
      setSelection(nodes: Iterable<InlineViewModelNode>) {
        hostContext.clearSelection();
        hostContext.expandSelection(nodes);
      },
      clearSelection() {
        hostContext.clearSelection();
      },
      get selection() {
        return hostContext.selection;
      },
    };
    let actionResult: ReturnType<T>;
    const ops = context.node[viewModel].tree.edit(
      () => {
        actionResult = action(context, ...args);
        if (endFocus && hostContext.hasSelection) {
          endFocus.selection = [...hostContext.selection];
        }
        return { startFocus, endFocus };
      },
      true,
      undefined,
      (focus, hasOperations) => {
        const belongsToRoot = (node: ViewModelNode) =>
          node === context.root || isAncestorOf(context.root, node);
        if (focus && belongsToRoot(focus.node)) return (endFocus = focus);
        endFocus = undefined;
        if (hasOperations && startFocus && !belongsToRoot(startFocus.node)) {
          const node = findNextEditable(context.root, context.root, true);
          if (node) endFocus = { node, offset: 0 };
        }
        return endFocus;
      },
      compositionFocus ? 'isolated' : 'record',
    );
    if (ops.length > 0 && !endFocus) {
      console.warn(`Edit action: "${action.name}" did not set final focus`);
    } else if (endFocus) {
      hostContext.focusNode = endFocus.node;
      hostContext.focusOffset = endFocus.offset;
      endFocus.node[viewModel].renderSignal.value++;
    }
    return actionResult!;
  }
  onInlineLinkClick({ detail: { destination: _destination } }: CustomEvent<InlineLinkClick>) {
    // TODO editor-port
    // if (/^(\w)+:/i.test(destination)) {
    //   window.open(destination);
    // } else {
    //   noAwait(this.navigateByName(destination, true));
    // }
  }
  onInlineKeyDown(event: CustomEvent<InlineKeyDown>) {
    // This function must only handle key events that do not generate text.
    // So as not to confuse handling here with insertText in onInlineInput.
    const {
      detail: { inline, node, keyboardEvent },
    } = event;
    const keyDown = normalizeKeys(keyboardEvent);
    const hostContext = cast(inline.hostContext);

    assert(inline.node);
    if (['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(keyDown.key)) {
      keyboardEvent.preventDefault();
      const direction = ['ArrowUp', 'ArrowLeft'].includes(keyDown.key) ? 'backward' : 'forward';
      const alter = keyDown.shiftKey ? 'extend' : 'move';
      const granularity = ['ArrowUp', 'ArrowDown'].includes(keyDown.key)
        ? 'line'
        : keyDown.ctrlKey
          ? 'word'
          : 'character';
      const result = hostContext.hasSelection ? 0 : inline.moveCaret(alter, direction, granularity);
      if (result === true) {
        hostContext.clearSelection();
      } else {
        function updateFocus(
          element: Element & { hostContext?: HostContext },
          node: InlineViewModelNode,
          offset: number,
        ) {
          // Retarget if there's any containing transclusion that has a selection.
          const target = getBlockSelectionTarget(element);
          if (target) {
            node = cast(target.node);
            element = target;
          }
          if (alter !== 'extend') {
            cast(element.hostContext).clearSelection();
          }
          while (true) {
            const root = cast(cast(element.hostContext).root);
            const next =
              direction === 'backward'
                ? findPreviousEditable(node, root)
                : findNextEditable(node, root);
            if (next) {
              // TODO: when moving forward by line, offset may be beyond the end
              // of the new element's first line
              focusNode(
                cast(element.hostContext),
                next,
                direction === 'backward' ? -offset : offset,
              );
              return { node, element, next };
            } else {
              const transclusion = getContainingTransclusion(element);
              if (!transclusion || alter === 'extend') return {};
              element = transclusion;
              node = cast(transclusion.node);
            }
          }
        }
        const { node: updatedNode, element, next } = updateFocus(inline, node, result);
        if (next && alter === 'extend') {
          const hostContext = cast(element.hostContext);
          if (hostContext.selectionAnchor) {
            hostContext.extendSelection(updatedNode, next);
          } else {
            hostContext.setSelection(updatedNode, next);
          }
        }
      }
    } else if (keyDown.key === 'Tab') {
      keyboardEvent.preventDefault();
      const mode = keyDown.shiftKey ? 'unindent' : 'indent';
      const blockTarget = getBlockSelectionTarget(inline);
      if (blockTarget) {
        this.runEditAction(blockTarget, editBlockSelectionIndent, mode);
      } else {
        this.runEditAction(inline, editInlineIndent, mode);
      }
    } else if ((keyDown.key === 'z' || keyDown.key === 'y') && keyDown.ctrlKey) {
      const root = hostContext.root;
      if (!root) return;
      keyboardEvent.preventDefault();
      const tree = root[viewModel].tree;
      const current = inline.node;
      const currentOffset = inline.getSelection()?.start.index ?? hostContext.focusOffset ?? 0;
      const result = keyDown.key === 'z' ? tree.undo(root) : tree.redo(root);
      if (result) {
        const valid = (node: InlineViewModelNode) =>
          node[viewModel].connected && (node === root || isAncestorOf(root, node));
        const recorded = result.focus;
        const focus =
          recorded && valid(recorded.node)
            ? recorded
            : current && valid(current)
              ? { node: current, offset: currentOffset }
              : { node: findNextEditable(root, root, true), offset: 0 };
        hostContext.clearSelection();
        if (recorded === focus && recorded.selection?.every(valid)) {
          hostContext.expandSelection(recorded.selection);
        }
        if (focus.node) focusNode(hostContext, focus.node, focus.offset);
      }
    } else if (keyDown.key === 'a' && keyDown.ctrlKey) {
      const { hostContext: selectedHostContext } = getBlockSelectionTarget(inline) ?? {};
      if (selectedHostContext?.hasSelection) {
        keyboardEvent.preventDefault();
        expandSelection(selectedHostContext);
      } else {
        const selection = inline.getSelection();
        if (
          (selection?.start.index === 0 && selection?.end.index === inline.node.content.length) ||
          hasCompleteCodeSelection(this, inline, node)
        ) {
          keyboardEvent.preventDefault();
          focusNode(hostContext, inline.node, 0);
          hostContext.setSelection(node, node);
        }
      }
    } else if (keyDown.key === 'Escape') {
      hostContext.clearSelection();
    } else if (keyDown.key === 'Backspace') {
      const selectionTarget = getBlockSelectionTarget(inline);
      if (!selectionTarget?.hostContext) return;
      keyboardEvent.preventDefault();
      this.runEditAction(selectionTarget, removeSelectedNodes);
    } else {
      return;
    }
  }
  onClipboard(event: ClipboardEvent) {
    if (event.defaultPrevented) return;
    const inline = event.composedPath().find((target) => target instanceof MarkdownInline);
    if (!(inline instanceof MarkdownInline)) return;
    const target = getBlockSelectionTarget(inline);
    if (!target?.hostContext) return;
    event.preventDefault();
    try {
      if (!event.clipboardData) return;
      const markdown = serializeSelection(target.hostContext);
      event.clipboardData.setData('text/plain', markdown);
      try {
        event.clipboardData.setData('text/markdown', markdown);
      } catch {
        // Plain text is sufficient for copy and cut.
      }
    } catch {
      return;
    }
    if (event.type === 'cut') this.runEditAction(target, removeSelectedNodes);
  }
  onPaste(event: ClipboardEvent) {
    if (event.defaultPrevented || !event.isTrusted) return;
    const inline = event.composedPath().find((target) => target instanceof MarkdownInline);
    if (!(inline instanceof MarkdownInline) || !inline.node) return;
    const markdown = event.clipboardData?.getData('text/markdown');
    if (!markdown) return;
    event.preventDefault();
    this.pasteMarkdown(inline, inline.node, markdown);
  }
  private pasteMarkdown(inline: MarkdownInline, node: InlineViewModelNode, markdown: string) {
    this.runEditAction(inline, (context: EditContext) => {
      context.startEditing();
      const { newFocus, newInlineNodes } = insertMarkdown(markdown, node) ?? {};
      if (newFocus) context.focus(newFocus, Infinity);
      if (newInlineNodes?.length) context.setSelection(newInlineNodes);
    });
  }
  async triggerPaste(
    inline: MarkdownInline,
    node: InlineViewModelNode,
    edit: { startIndex: number; oldEndIndex: number },
    forceMarkdown = false,
  ) {
    const content = await navigator.clipboard.read();
    const mdItem = content.find((item) => item.types.includes('web text/markdown'));
    let mdText: string | undefined;
    if (mdItem) {
      const blob = await mdItem.getType('web text/markdown');
      mdText = await blob.text();
      // TODO: Drop this hack for broken custom formats.
      if (mdText.length === 0) {
        mdText = await navigator.clipboard.readText();
      }
    } else if (forceMarkdown) {
      mdText = await navigator.clipboard.readText();
    }
    if (mdText) {
      this.pasteMarkdown(inline, node, mdText);
    } else {
      let text = await navigator.clipboard.readText();
      // TODO: Escape block creation.
      text = text.replace(/\n/g, ' ');
      this.runEditAction(inline, editInlineNode, {
        ...edit,
        newText: text,
        newEndIndex: edit.startIndex + text.length,
      }); // TODO: wrong context
    }
  }
  onInlineInput(event: CustomEvent<InlineInput>) {
    const {
      detail: { inline, inputEvent, inputStart, inputEnd },
    } = event;
    if (!inline.node) return;

    // TODO: Most edit types could be handled here. E.g. insertText
    // could replace the selection.
    const { hostContext: selectionHostContext } = getBlockSelectionTarget(inline) ?? {};
    selectionHostContext?.clearSelection();
    if (this.handleInlineInputAsBlockEdit(event)) {
      return;
    }
    // TODO: Perhaps the remainder should be handled by an inline editor?
    let newText;
    let startIndex;
    let oldEndIndex;
    let newEndIndex: number;
    if (
      inputEvent.inputType === 'insertText' ||
      inputEvent.inputType === 'insertReplacementText' ||
      inputEvent.inputType === 'insertFromPaste' ||
      inputEvent.inputType === 'deleteByCut' ||
      inputEvent.inputType === 'deleteContentBackward' ||
      inputEvent.inputType === 'deleteWordBackward'
    ) {
      startIndex = inputStart.index;
      oldEndIndex = inputEnd.index;
      if (inputEvent.inputType === 'insertReplacementText') {
        newText = inputEvent.dataTransfer?.getData('text/plain') ?? '';
      } else if (inputEvent.inputType === 'insertFromPaste') {
        // Note: We can't use dataTransfer here because not all types are
        // exposed. 'web text/markdown' for example.
        noAwait(this.triggerPaste(inline, inline.node, { startIndex, oldEndIndex }));
        return;
      } else if (inputEvent.inputType === 'deleteWordBackward') {
        inline.moveCaret('move', 'backward', 'word');
        const selection = cast(inline.getSelection());
        startIndex = selection.start.index;
        newText = '';
      } else if (inputEvent.inputType === 'deleteByCut') {
        newText = '';
      } else if (inputEvent.inputType === 'deleteContentBackward') {
        newText = '';
        if (startIndex === oldEndIndex) {
          startIndex--;
          const low = inline.node.content.charCodeAt(startIndex);
          const high = inline.node.content.charCodeAt(startIndex - 1);
          if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
            startIndex--;
          }
        }
        startIndex = Math.max(0, startIndex);
      } else {
        newText = inputEvent.data ?? '';
      }
      newEndIndex = startIndex + newText.length;
    } else {
      console.log('unsupported inputType:', inputEvent.inputType);
      return;
    }

    const edit = {
      newText,
      startIndex,
      oldEndIndex,
      newEndIndex,
    };

    this.runEditAction(inline, (context: EditContext) => {
      editInlineNode(context, edit);
    });
  }
  handleInlineInputAsBlockEdit({
    detail: { inline, inputEvent, inputStart, inputEnd },
  }: CustomEvent<InlineInput>): boolean {
    if (!inline.node) return false;
    if (
      inputEvent.inputType === 'deleteContentBackward' ||
      inputEvent.inputType === 'deleteWordBackward'
    ) {
      if (inputStart.index !== 0 || inputEnd.index !== 0) return false;
      return this.runEditAction(inline, deleteContentBackwards);
    } else if (inputEvent.inputType === 'insertParagraph') {
      this.runEditAction(inline, insertParagraph, inputStart.index, inputEnd.index);
      return true;
    } else if (inputEvent.inputType === 'insertLineBreak') {
      this.runEditAction(inline, insertLineBreak, inputStart.index);
      return true;
    }
    return false;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'md-editor': Editor;
  }
}
