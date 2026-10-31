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
import { copyMarkdownToClipboard, insertMarkdown, serializeSelection } from './copy-paste-util.js';
import { Focus } from '../markdown/view-model-ops.js';
import { NodeSignalController } from '../markdown/node-signal-controller.js';
import { normalizeKeys } from './keyboard.js';

type ExcludeFirst<T extends Parameters<any>> = T extends [any, ...infer Rest] ? Rest : never;

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

@customElement('md-editor')
export class Editor extends LitElement {
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
      ></md-block-render>`;
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
        if (element instanceof MarkdownInline) {
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
        if (selection?.start.index === 0 && selection?.end.index === inline.node.content.length) {
          keyboardEvent.preventDefault();
          focusNode(hostContext, inline.node, 0);
          hostContext.setSelection(node, node);
        }
      }
    } else if (keyDown.key === 'c' && keyDown.ctrlKey) {
      const { hostContext } = getBlockSelectionTarget(inline) ?? {};
      if (!hostContext) return;
      keyboardEvent.preventDefault();
      noAwait(copyMarkdownToClipboard(serializeSelection(hostContext)));
    } else if (keyDown.key === 'x' && keyDown.ctrlKey) {
      const selectionTarget = getBlockSelectionTarget(inline);
      if (!selectionTarget?.hostContext) return;
      keyboardEvent.preventDefault();
      noAwait(copyMarkdownToClipboard(serializeSelection(selectionTarget.hostContext)));
      this.runEditAction(selectionTarget, removeSelectedNodes);
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
      this.runEditAction(inline, (context: EditContext) => {
        context.startEditing();
        const { newFocus, newInlineNodes } = insertMarkdown(mdText, node) ?? {};
        if (newFocus) {
          context.focus(newFocus, Infinity);
        }
        if (newInlineNodes?.length) {
          context.setSelection(newInlineNodes);
        }
      });
    } else {
      let text = await navigator.clipboard.readText();
      // TODO: Escape block creation.
      text = text.replace(/\n/g, ' ');
      this.runEditAction(inline, editInlineNode, {
        ...edit,
        newText: text,
        newEndIndex: edit.oldEndIndex + text.length,
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
