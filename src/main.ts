import { LitElement, css, html } from 'lit';

import './editing/canonical-editor.js';
import './editing/mobile-keyboard-toolbar.js';
import './markdown/transclusion.js';
import { MarkdownInline } from './markdown/inline-render.js';
import type {
  MobileToolbarAction,
  MobileToolbarActionEvent,
  MobileToolbarFocusEvent,
} from './editing/mobile-keyboard-toolbar.js';
import { createBlockParser, parseMarkdownTree } from './markdown/block-parser/api.js';
import { CanonicalWriter } from './markdown/canonical/writer.js';
import { CanonicalDocument } from './markdown/canonical/document.js';
import type { BlockParser } from './markdown/block-parser/api.js';
import type { DocumentNode } from './markdown/node.js';
import { serializeToString } from './markdown/block-serializer.js';
import type { MarkdownRenderDelegate } from './markdown/render-delegate.js';
import { viewModel } from './markdown/view-model-node.js';
import type { ViewModelNode } from './markdown/view-model-node.js';
import type { MarkdownTree } from './markdown/view-model.js';
import { styles as appStyles } from './style.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, ...appStyles];

interface GrainVirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRect;
}

const getVirtualKeyboard = () =>
  (navigator as Navigator & { virtualKeyboard?: GrainVirtualKeyboard }).virtualKeyboard;

const sample = `# Block Harness
This harness exercises the legacy renderer port with *emphasis*, **strong text**, ~~strikethrough~~, \`inline code\`, and a #tag.

## Links And Tags
Try an [inline link](https://example.com), a bare autolink <https://openai.com>, and mixed text with #notes and #render-test.

## Lists
- plain bullet item
- [ ] unchecked task with *inline formatting*
- [x] completed task with \`code\` and a [link](https://lit.dev)
- nested list parent
  - child bullet
  - child bullet with #nested/tag

## Quote
> Quoted text can still contain **strong text**, \`code\`, and links like <https://vite.dev>.
>
> - quoted list item
> - second item

## Section Nesting
### Deep Heading
Paragraph text under a nested heading with **bold**, *italic*, and ~~edited~~ content.

\`\`\`js
function greet(name) {
  return \`hello, \${name}\`;
}
\`\`\`

\`\`\`md
## Transcluded Markdown
This block is rendered through the transclusion delegate.

- nested item
- **formatted** child content
\`\`\``;

const transclusionRenderDelegate: MarkdownRenderDelegate = {
  renderCodeBlock({ node, selected }) {
    if (node.info !== 'md') return undefined;
    return html`<md-transclusion
      .node=${node}
      .root=${parseMarkdownTree(node.content).root}
      ?selected=${selected}
    ></md-transclusion>`;
  },
};

function singleTextReplacement(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}

function sourceChange(before: string, after: string) {
  // Canonical serialization may add one terminal newline that has no source-edit coordinate yet.
  const trailingNewline = !before.endsWith('\n') && after.endsWith('\n') ? '\n' : '';
  const editableAfter = trailingNewline ? after.slice(0, -1) : after;
  return {
    ...singleTextReplacement(before, editableAfter),
    editableAfter,
    trailingNewline,
  };
}

function mapOffsetThroughReplacement(
  offset: number,
  from: number,
  to: number,
  insertLength: number,
) {
  if (offset <= from) return offset;
  if (offset >= to) return offset + insertLength - (to - from);
  return from + insertLength;
}

function mapSelectionThroughRebasedReplacement(
  offset: number,
  replacement: { readonly from: number; readonly to: number; readonly insert: string },
  rebasedFrom: number,
  rebasedTo: number,
  canonicalChange: { readonly from: number; readonly to: number; readonly insert: string },
) {
  const insertedEnd = replacement.from + replacement.insert.length;
  if (offset >= replacement.from && offset <= insertedEnd) {
    return rebasedFrom + offset - replacement.from;
  }

  // Compose the inverse local edit, canonical edit, then rebased local edit.
  const originalOffset =
    offset < replacement.from
      ? offset
      : offset + replacement.to - replacement.from - replacement.insert.length;
  const canonicalOffset = mapOffsetThroughReplacement(
    originalOffset,
    canonicalChange.from,
    canonicalChange.to,
    canonicalChange.insert.length,
  );
  return mapOffsetThroughReplacement(
    canonicalOffset,
    rebasedFrom,
    rebasedTo,
    replacement.insert.length,
  );
}

function replacementsOverlap(
  first: { readonly from: number; readonly to: number },
  second: { readonly from: number; readonly to: number },
) {
  if (first.from === first.to) return second.from < first.from && first.from < second.to;
  if (second.from === second.to) return first.from < second.from && second.from < first.to;
  return first.from < second.to && second.from < first.to;
}

class MarkdownDevHarness extends LitElement {
  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
      min-height: 100vh;
      color: var(--root-color);
      background:
        radial-gradient(
          circle at top left,
          color-mix(in srgb, var(--md-accent-color) 14%, transparent),
          transparent 28%
        ),
        linear-gradient(
          180deg,
          color-mix(in srgb, var(--root-background-color) 92%, white) 0%,
          color-mix(in srgb, var(--root-background-color) 96%, black) 100%
        );
      font:
        15px/1.5 'Iowan Old Style',
        'Palatino Linotype',
        'Book Antiqua',
        Palatino,
        Georgia,
        serif;
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
      min-width: 0;
      min-height: 100vh;
      padding-bottom: var(--mobile-keyboard-reserve, 0px);
    }

    .panel {
      min-width: 0;
      padding: 2rem;
    }

    .editor {
      border-right: 1px solid color-mix(in srgb, var(--root-color) 10%, transparent);
      background: color-mix(in srgb, var(--root-background-color) 84%, transparent);
      backdrop-filter: blur(18px);
    }

    .preview {
      background: color-mix(in srgb, var(--root-background-color) 92%, transparent);
    }

    h1 {
      margin: 0 0 0.35rem;
      font-size: clamp(1.8rem, 2vw + 1rem, 3rem);
      line-height: 1;
      letter-spacing: -0.03em;
    }

    .lede {
      max-width: 40rem;
      margin: 0 0 1.4rem;
      color: color-mix(in srgb, var(--root-color) 72%, transparent);
    }

    .label {
      display: block;
      margin-bottom: 0.55rem;
      color: var(--md-accent-color);
      font:
        600 0.78rem/1.2 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    textarea {
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      min-height: 68vh;
      resize: vertical;
      border: 1px solid color-mix(in srgb, var(--root-color) 14%, transparent);
      border-radius: 18px;
      background: color-mix(in srgb, var(--root-background-color) 90%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--root-background-color) 70%, white);
      padding: 1rem 1.05rem;
      color: var(--root-color);
      font:
        14px/1.55 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }

    textarea:focus {
      outline: 2px solid color-mix(in srgb, var(--md-accent-color) 25%, transparent);
      outline-offset: 2px;
    }

    .meta {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-top: 0.85rem;
      color: color-mix(in srgb, var(--root-color) 60%, transparent);
      font-size: 0.9rem;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 0.9rem;
      flex-wrap: wrap;
      margin-top: 1rem;
    }

    .play {
      border: 0;
      border-radius: 999px;
      background: var(--md-accent-color);
      color: var(--root-background-color);
      padding: 0.65rem 1rem;
      font:
        600 0.84rem/1 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      cursor: pointer;
    }

    .play[disabled] {
      opacity: 0.55;
      cursor: default;
    }

    .slider-wrap {
      display: grid;
      gap: 0.3rem;
      min-width: min(100%, 18rem);
    }

    .slider-label {
      color: color-mix(in srgb, var(--root-color) 68%, transparent);
      font:
        600 0.78rem/1.2 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      letter-spacing: 0.02em;
    }

    input[type='range'] {
      width: 100%;
      accent-color: var(--md-accent-color);
    }

    .preview-card {
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
      min-height: 68vh;
      border: 1px solid color-mix(in srgb, var(--root-color) 8%, transparent);
      border-radius: 24px;
      background: color-mix(in srgb, var(--root-background-color) 90%, transparent);
      box-shadow:
        0 24px 60px color-mix(in srgb, var(--root-color) 8%, transparent),
        inset 0 1px 0 color-mix(in srgb, var(--root-background-color) 65%, white);
      padding: 1.35rem 1.35rem 1.6rem;
    }

    .history-status {
      margin: 0.75rem 0 0;
      color: var(--md-accent-color);
      font:
        600 0.82rem/1.4 ui-sans-serif,
        system-ui,
        sans-serif;
    }

    .tabs {
      display: inline-flex;
      box-sizing: border-box;
      max-width: 100%;
      overflow-x: auto;
      gap: 0.45rem;
      margin-bottom: 0.85rem;
      padding: 0.2rem;
      border-radius: 999px;
      background: color-mix(in srgb, var(--root-color) 6%, transparent);
    }

    .simulation-toggle {
      border: 1px dashed color-mix(in srgb, var(--root-color) 25%, transparent);
      border-radius: 999px;
      background: transparent;
      color: color-mix(in srgb, var(--root-color) 72%, transparent);
      padding: 0.5rem 0.75rem;
      font:
        600 0.75rem/1 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      cursor: pointer;
    }

    .simulation-toggle[aria-pressed='true'] {
      border-style: solid;
      color: var(--md-accent-color);
    }

    .simulated-keyboard {
      position: fixed;
      z-index: 1000;
      right: 0;
      left: 0;
      box-sizing: border-box;
      display: grid;
      grid-template-rows: auto 1fr 1fr 1fr;
      gap: 0.45rem;
      height: 280px;
      padding: 0.65rem 0.5rem 0.8rem;
      border-top: 1px solid #c9d0c5;
      border-radius: 14px 14px 0 0;
      background: #e5e8e2;
      box-shadow: 0 -8px 28px rgb(0 0 0 / 12%);
      color: #334432;
      font:
        12px/1.2 system-ui,
        sans-serif;
    }

    .simulated-keyboard[hidden] {
      display: none;
    }

    .keyboard-label {
      text-align: center;
      color: #596454;
      font:
        600 0.65rem/1.2 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .key-row {
      display: flex;
      justify-content: center;
      gap: 0.35rem;
    }

    .key-row span {
      display: grid;
      flex: 1 1 0;
      max-width: 3rem;
      min-width: 0;
      place-items: center;
      border-radius: 5px;
      background: #fafbf7;
      box-shadow: 0 1px 2px rgb(0 0 0 / 14%);
      font-size: 0.8rem;
    }

    .key-row .wide-key {
      max-width: 6rem;
      background: #d3d9d0;
    }

    .tab {
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: color-mix(in srgb, var(--root-color) 70%, transparent);
      padding: 0.5rem 0.9rem;
      font:
        600 0.84rem/1 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      letter-spacing: 0.04em;
      cursor: pointer;
    }

    .tab[selected] {
      background: var(--root-background-color);
      color: var(--md-accent-color);
      box-shadow: 0 6px 18px color-mix(in srgb, var(--root-color) 8%, transparent);
    }

    .serialized {
      width: 100%;
      min-height: 68vh;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--root-color);
      font:
        14px/1.55 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }

    .tree {
      width: 100%;
      min-height: 68vh;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--root-color);
      font:
        13px/1.5 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }

    @media (max-width: 920px) {
      .shell {
        grid-template-columns: minmax(0, 1fr);
      }

      .panel {
        padding: clamp(1rem, 4vw, 2rem);
      }

      .editor {
        border-right: 0;
        border-bottom: 1px solid color-mix(in srgb, var(--root-color) 8%, transparent);
      }

      textarea,
      .preview-card {
        min-height: 42vh;
      }
    }
  `;

  static override properties = {
    root: { attribute: false },
    source: { state: true },
    pendingText: { state: true },
    parseMode: { state: true },
    playbackIndex: { state: true },
    playing: { state: true },
    renderVersion: { state: true },
    canonicalDocument: { state: true },
    canonicalWriter: { state: true },
    activeTab: { state: true },
    serializedMarkdown: { state: true },
    treeJson: { state: true },
    toolbarVisible: { state: true },
    toolbarDisabled: { state: true },
    toolbarUndoDisabled: { state: true },
    toolbarRedoDisabled: { state: true },
    historyStatus: { state: true },
    toolbarTop: { state: true },
    simulatedKeyboard: { state: true },
    keyboardTop: { state: true },
  };

  declare root: ViewModelNode | undefined;
  declare private source: string;
  declare private pendingText: string;
  declare private parseMode: string;
  declare private playbackIndex: number;
  declare private playing: boolean;
  declare private renderVersion: number;
  declare private canonicalDocument: CanonicalDocument | undefined;
  declare private canonicalWriter: CanonicalWriter | undefined;
  declare private activeTab: 'render' | 'serialize' | 'tree';
  declare private serializedMarkdown: string;
  declare private treeJson: string;
  declare private toolbarVisible: boolean;
  declare private toolbarDisabled: boolean;
  declare private toolbarUndoDisabled: boolean;
  declare private toolbarRedoDisabled: boolean;
  declare private historyStatus: string;
  declare private toolbarTop: number;
  declare private simulatedKeyboard: boolean;
  declare private keyboardTop: number;
  private parser: BlockParser;
  private observedTree: MarkdownTree | undefined;
  private parserReusable = false;
  private playbackTimer: number | undefined;
  private readonly playbackDelayMs = 10;
  private activeInline: MarkdownInline | undefined;
  private toolbarHasFocus = false;
  private keyboardHeight = 0;
  private observedKeyboardApi: GrainVirtualKeyboard | undefined;
  private previousOverlayContent: boolean | undefined;
  private selectionChangeDocument: Document | undefined;
  private selectionChangeRoot: ShadowRoot | undefined;
  private visualViewportBaseline = 0;
  private readinessTimer: number | undefined;
  private caretFrame: number | undefined;
  private canonicalExportFrame: number | undefined;
  private markdownExportDocument: CanonicalDocument | undefined;
  private markdownExportRevision = -1;
  private treeExportDocument: CanonicalDocument | undefined;
  private treeExportRevision = -1;
  private canonicalTreeCache?: {
    readonly document: CanonicalDocument;
    readonly revision: number;
    readonly tree: DocumentNode;
  };

  constructor() {
    super();
    this.parser = createBlockParser();
    this.root = undefined;
    this.source = sample;
    this.pendingText = '';
    this.parseMode = 'initial';
    this.playbackIndex = sample.length;
    this.playing = false;
    this.renderVersion = 0;
    this.canonicalDocument = undefined;
    this.canonicalWriter = undefined;
    this.activeTab = 'render';
    this.serializedMarkdown = '';
    this.treeJson = '';
    this.toolbarVisible = false;
    this.toolbarDisabled = true;
    this.toolbarUndoDisabled = true;
    this.toolbarRedoDisabled = true;
    this.historyStatus = '';
    this.toolbarTop = 0;
    this.simulatedKeyboard = false;
    this.keyboardTop = 0;
    this.canonicalExportFrame = undefined;
    this.reparse(sample, true);
    this.addEventListener('focusin', this.onFocusIn);
    this.addEventListener('focusout', this.onFocusOut);
    this.addEventListener('inline-input', this.onEditorInput);
    this.addEventListener('inline-keydown', this.onEditorKeydown);
    this.addEventListener('inline-composition-start', this.onCompositionChange);
    this.addEventListener('inline-composition-end', this.onCompositionChange);
    this.addEventListener('inline-projection-recovery', this.onCompositionChange);
    this.addEventListener('canonical-change', this.onCanonicalChange as EventListener);
    this.addEventListener('canonical-history-reset', this.onCanonicalHistoryReset as EventListener);
  }

  override render() {
    return html`
      <main class="shell">
        <section class="panel editor">
          <h1>Block Render Harness</h1>
          <p class="lede">
            This page reparses markdown on every input change using the new chunk-based block parser
            and renders only block structure.
          </p>
          <label class="label" for="source">Markdown Source</label>
          <textarea
            id="source"
            .value=${this.source}
            @focus=${this.onSourceFocus}
            @input=${this.onInput}
            @copy=${this.onSourceCopy}
            spellcheck="false"
          ></textarea>
          <div class="meta">
            <span>${this.source.length} chars</span>
            <span>${this.source.split('\n').length} lines</span>
            <span>pending tail: ${this.pendingText.length}</span>
            <span>mode: ${this.parseMode}</span>
          </div>
          <div class="controls">
            <button class="play" @click=${this.onPlayToggle}>
              ${this.playing ? 'Stop' : 'Play'}
            </button>
            <label class="slider-wrap">
              <span class="slider-label"
                >Playback progress: ${this.playbackIndex}/${this.source.length}</span
              >
              <input
                type="range"
                min="0"
                max=${String(this.source.length)}
                step="1"
                .value=${String(this.playbackIndex)}
                @input=${this.onProgressInput}
              />
            </label>
            <span>50ms per char</span>
          </div>
        </section>
        <section class="panel preview">
          <label class="label">Tree Output</label>
          <div class="tabs">
            <button
              class="tab"
              ?selected=${this.activeTab === 'render'}
              @click=${() => this.setTab('render')}
            >
              Render
            </button>
            <button
              class="tab"
              ?selected=${this.activeTab === 'serialize'}
              @click=${() => this.setTab('serialize')}
            >
              Serialize
            </button>
            <button
              class="tab"
              ?selected=${this.activeTab === 'tree'}
              @click=${() => this.setTab('tree')}
            >
              Tree
            </button>
            <button
              class="simulation-toggle"
              aria-pressed=${this.simulatedKeyboard}
              @pointerdown=${this.preserveControlFocus}
              @click=${this.toggleSimulatedKeyboard}
            >
              ${this.simulatedKeyboard ? 'Hide simulated keyboard' : 'Show simulated keyboard'}
            </button>
          </div>
          <div class="preview-card">
            ${
              this.activeTab === 'render'
                ? this.playing
                  ? this.root
                    ? html`<md-block-render
                        inert
                        .block=${this.root}
                        .renderDelegate=${transclusionRenderDelegate}
                      ></md-block-render>`
                    : html``
                  : this.canonicalDocument && this.canonicalWriter
                    ? html`<md-canonical-editor
                        .document=${this.canonicalDocument}
                        .writer=${this.canonicalWriter}
                        .renderDelegate=${transclusionRenderDelegate}
                      ></md-canonical-editor>`
                    : html``
                : this.activeTab === 'serialize'
                  ? html`<pre class="serialized">${this.serializedMarkdown}</pre>`
                  : html`<pre class="tree">${this.treeJson}</pre>`
            }
            ${
              this.historyStatus
                ? html`<p class="history-status" role="status">${this.historyStatus}</p>`
                : ''
            }
          </div>
        </section>
      </main>
      <md-mobile-keyboard-toolbar
        .visible=${this.toolbarVisible}
        .disabled=${this.toolbarDisabled}
        .undoDisabled=${this.toolbarUndoDisabled}
        .redoDisabled=${this.toolbarRedoDisabled}
        style="--toolbar-top: ${this.toolbarTop}px"
        @mobile-toolbar-action=${this.onMobileToolbarAction}
        @mobile-toolbar-focus-change=${this.onToolbarFocusChange}
      ></md-mobile-keyboard-toolbar>
      <div
        class="simulated-keyboard"
        ?hidden=${!this.simulatedKeyboard || !this.toolbarVisible}
        style="top: ${this.keyboardTop}px"
        role="presentation"
        aria-label="Simulated software keyboard for desktop preview"
      >
        <div class="keyboard-label">Simulated software keyboard · desktop preview</div>
        <div class="key-row" aria-hidden="true">
          ${['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'].map((key) => html`<span>${key}</span>`)}
        </div>
        <div class="key-row" aria-hidden="true">
          ${['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'].map((key) => html`<span>${key}</span>`)}
        </div>
        <div class="key-row" aria-hidden="true">
          <span class="wide-key">?123</span>
          <span class="wide-key">↵</span>
          <span class="wide-key" style="max-width: 12rem">space</span>
          <span class="wide-key">⌫</span>
        </div>
      </div>
    `;
  }

  private onInput = (event: Event) => {
    const field = event.currentTarget as HTMLTextAreaElement;
    const previousSource = this.source;
    let value = field.value;
    const replacement = singleTextReplacement(previousSource, value);
    const selectionStart = field.selectionStart;
    const selectionEnd = field.selectionEnd;
    const selectionDirection = field.selectionDirection ?? 'none';
    const currentDocument = this.canonicalDocument;
    if (
      currentDocument &&
      (this.markdownExportDocument !== currentDocument ||
        this.markdownExportRevision < currentDocument.acceptedRevision)
    ) {
      this.flushCanonicalExports(currentDocument, false);
      if (this.source !== previousSource) {
        const canonicalChange = sourceChange(previousSource, this.source);
        if (replacementsOverlap(replacement, canonicalChange)) {
          // The accepted canonical edit wins when the stale Source edit touches the same text.
          field.value = this.source;
          field.setSelectionRange(
            mapOffsetThroughReplacement(
              selectionStart,
              canonicalChange.from,
              canonicalChange.to,
              canonicalChange.insert.length,
            ),
            mapOffsetThroughReplacement(
              selectionEnd,
              canonicalChange.from,
              canonicalChange.to,
              canonicalChange.insert.length,
            ),
            selectionDirection,
          );
          return;
        }

        const rebasedFrom =
          replacement.from === canonicalChange.from &&
          replacement.to > replacement.from &&
          canonicalChange.from === canonicalChange.to
            ? // A range starting at a canonical insertion gap targets the old text after it.
              canonicalChange.from + canonicalChange.insert.length
            : mapOffsetThroughReplacement(
                replacement.from,
                canonicalChange.from,
                canonicalChange.to,
                canonicalChange.insert.length,
              );
        const rebasedTo = mapOffsetThroughReplacement(
          replacement.to,
          canonicalChange.from,
          canonicalChange.to,
          canonicalChange.insert.length,
        );
        value =
          canonicalChange.editableAfter.slice(0, rebasedFrom) +
          replacement.insert +
          canonicalChange.editableAfter.slice(rebasedTo) +
          canonicalChange.trailingNewline;
        field.value = value;
        field.setSelectionRange(
          mapSelectionThroughRebasedReplacement(
            selectionStart,
            replacement,
            rebasedFrom,
            rebasedTo,
            canonicalChange,
          ),
          mapSelectionThroughRebasedReplacement(
            selectionEnd,
            replacement,
            rebasedFrom,
            rebasedTo,
            canonicalChange,
          ),
          selectionDirection,
        );
      }
    }
    this.stopPlayback();
    this.reparse(value);
  };

  private onSourceFocus = (event: FocusEvent) => {
    const field = event.currentTarget as HTMLTextAreaElement;
    const previousSource = this.source;
    const selectionStart = field.selectionStart;
    const selectionEnd = field.selectionEnd;
    const selectionDirection = field.selectionDirection ?? 'none';
    this.flushCanonicalExports(this.canonicalDocument, false);
    if (this.source === previousSource) return;

    const change = sourceChange(previousSource, this.source);
    const start = mapOffsetThroughReplacement(
      selectionStart,
      change.from,
      change.to,
      change.insert.length,
    );
    const end = mapOffsetThroughReplacement(
      selectionEnd,
      change.from,
      change.to,
      change.insert.length,
    );
    field.value = this.source;
    const restoreSelection = () => {
      if (field.isConnected && field.value === this.source)
        field.setSelectionRange(start, end, selectionDirection);
    };
    restoreSelection();
    void this.updateComplete.then(restoreSelection);
  };

  private onSourceCopy = (event: ClipboardEvent) => {
    const field = event.currentTarget as HTMLTextAreaElement;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const direction = field.selectionDirection ?? 'none';
    if (!this.playing) this.flushCanonicalExports(this.canonicalDocument, false);
    if (field.value !== this.source) {
      field.value = this.source;
      field.setSelectionRange(
        Math.min(start, field.value.length),
        Math.min(end, field.value.length),
        direction,
      );
    }
  };

  private onProgressInput = (event: Event) => {
    this.markdownForSave();
    const value = Number((event.currentTarget as HTMLInputElement).value);
    this.stopPlayback();
    this.setPlaybackProgress(value);
  };

  private onPlayToggle = () => {
    if (this.playing) {
      this.stopPlayback();
      return;
    }
    this.markdownForSave();
    this.startPlayback();
  };

  /** Returns the latest Markdown for a host save after flushing canonical edits. */
  markdownForSave(): string {
    this.flushCanonicalExports(this.canonicalDocument, false);
    return this.source;
  }

  private setTab(tab: 'render' | 'serialize' | 'tree') {
    if (!this.playing) this.flushCanonicalExports(this.canonicalDocument, tab === 'tree');
    this.activeTab = tab;
    if (tab !== 'render') this.clearEditingTarget();
    else this.refreshKeyboardState();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.canonicalDocument || !this.canonicalWriter) this.reparse(this.source, true);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onOrientationChange);
    window.visualViewport?.addEventListener('resize', this.onViewportChange);
    window.visualViewport?.addEventListener('scroll', this.onViewportChange);
  }

  override disconnectedCallback(): void {
    this.observeRootTree(undefined);
    this.stopPlayback();
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onOrientationChange);
    window.visualViewport?.removeEventListener('resize', this.onViewportChange);
    window.visualViewport?.removeEventListener('scroll', this.onViewportChange);
    this.clearReadinessTimer();
    if (this.canonicalExportFrame !== undefined) {
      cancelAnimationFrame(this.canonicalExportFrame);
      this.canonicalExportFrame = undefined;
    }
    this.stopObservingNativeSelection();
    this.stopObservingVirtualKeyboard();
    const retiredWriter = this.canonicalWriter;
    const retiredDocument = this.canonicalDocument;
    const pendingRenderUpdates = this.pendingRenderUpdates();
    this.canonicalWriter = undefined;
    this.canonicalDocument = undefined;
    if (retiredWriter && retiredDocument)
      void this.disposeCanonical(retiredWriter, retiredDocument, undefined, pendingRenderUpdates);
    super.disconnectedCallback();
  }

  protected override updated() {
    this.observeRootTree(this.root?.[viewModel].tree);
  }

  private startPlayback() {
    this.stopPlayback();
    this.playing = true;
    this.parserReusable = false;
    this.playbackIndex = 0;
    this.parser = createBlockParser();
    this.parseMode = 'append';
    this.root = this.parser.getTree().root;
    this.serializedMarkdown = '';
    this.updateFromParser();

    this.playbackTimer = window.setInterval(() => {
      if (this.playbackIndex >= this.source.length) {
        this.finishPlayback();
        return;
      }
      const nextChar = this.source[this.playbackIndex] ?? '';
      this.parser.push(nextChar);
      this.playbackIndex += 1;
      this.parseMode = 'append';
      this.updateFromParser();
      if (this.playbackIndex >= this.source.length) {
        this.finishPlayback();
      }
    }, this.playbackDelayMs);
  }

  private stopPlayback() {
    if (this.playbackTimer !== undefined) {
      window.clearInterval(this.playbackTimer);
      this.playbackTimer = undefined;
    }
    this.playing = false;
  }

  private finishPlayback() {
    this.stopPlayback();
    this.parserReusable = false;
    this.parser.finish();
    this.playbackIndex = this.source.length;
    this.parseMode = 'play-finished';
    this.updateFromParser();
  }

  private reparse(markdown: string, forceFull = false) {
    if (!forceFull && this.parserReusable && markdown.startsWith(this.source)) {
      const appended = markdown.slice(this.source.length);
      this.source = markdown;
      this.parser.push(appended);
      this.parseMode = 'append';
    } else {
      this.parser = createBlockParser();
      this.source = markdown;
      this.parser.push(markdown);
      this.parseMode = forceFull ? 'initial' : 'full';
    }

    this.parserReusable = true;
    this.playbackIndex = this.source.length;
    this.updateFromParser();
  }

  private setPlaybackProgress(index: number, mode = 'scrub') {
    this.parserReusable = false;
    const clamped = Math.max(0, Math.min(index, this.source.length));
    this.parser = createBlockParser();
    const partial = this.source.slice(0, clamped);
    this.parser.push(partial);
    this.playbackIndex = clamped;
    this.parseMode = mode;
    this.updateFromParser();
  }

  private updateFromParser() {
    const tree = this.parser.getTree();
    const serializedTree = tree.serialize();
    if (this.parseMode != 'append') {
      this.root = tree.root;
    }
    this.serializedMarkdown = serializeToString(serializedTree);
    this.pendingText = this.parser.getPendingText();
    this.treeJson = JSON.stringify(serializedTree, null, 2);
    this.renderVersion++;
    if (!this.playing) this.replaceCanonicalDocument(serializedTree as DocumentNode);
  }

  private replaceCanonicalDocument(tree: DocumentNode) {
    const previousDocument = this.canonicalDocument;
    const previousWriter = this.canonicalWriter;
    const pendingRenderUpdates = this.pendingRenderUpdates();
    const nextDocument = CanonicalDocument.fromTree(tree);
    const nextWriter = new CanonicalWriter(nextDocument);
    this.canonicalDocument = nextDocument;
    this.canonicalWriter = nextWriter;
    this.markdownExportDocument = nextDocument;
    this.markdownExportRevision = nextDocument.acceptedRevision;
    this.treeExportDocument = nextDocument;
    this.treeExportRevision = nextDocument.acceptedRevision;
    this.canonicalTreeCache = undefined;
    if (previousDocument && previousWriter) {
      void this.disposeCanonical(
        previousWriter,
        previousDocument,
        nextDocument,
        pendingRenderUpdates,
      );
    }
  }

  private pendingRenderUpdates() {
    const elements: Array<HTMLElement & { updateComplete?: Promise<unknown> }> = [];
    const visit = (root: ParentNode) => {
      for (const element of root.querySelectorAll<HTMLElement>('*')) {
        if ('updateComplete' in element) {
          elements.push(element as HTMLElement & { updateComplete?: Promise<unknown> });
        }
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    if (this.shadowRoot) visit(this.shadowRoot);
    return elements;
  }

  private async disposeCanonical(
    writer: CanonicalWriter,
    document: CanonicalDocument,
    replacement?: CanonicalDocument,
    pendingRenderUpdates: readonly (HTMLElement & { updateComplete?: Promise<unknown> })[] = [],
  ) {
    await this.updateComplete;
    if (replacement) {
      const editor = this.shadowRoot?.querySelector('md-canonical-editor');
      if (editor?.document === replacement) await editor.updateComplete;
    }
    for (const element of pendingRenderUpdates) await element.updateComplete;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    writer.close();
    document.close();
  }

  private onCanonicalChange = (event: CustomEvent<{ readonly document: CanonicalDocument }>) => {
    const document = event.detail.document;
    if (document !== this.canonicalDocument) return;
    this.historyStatus = '';
    this.refreshToolbarHistoryAvailability();
    this.scheduleCanonicalExports(document.acceptedRevision);
  };

  private scheduleCanonicalExports(revision: number) {
    if (this.canonicalExportFrame !== undefined) return;
    this.canonicalExportFrame = requestAnimationFrame(() => {
      this.canonicalExportFrame = undefined;
      const document = this.canonicalDocument;
      if (!document || document.acceptedRevision < revision) return;
      this.flushCanonicalExports(document, this.activeTab === 'tree');
    });
  }

  /** Exports only the current view's derived data; source/export reads force the latest revision. */
  private flushCanonicalExports(document: CanonicalDocument | undefined, includeTreeJson: boolean) {
    if (!document || this.playing) return;
    const revision = document.acceptedRevision;
    const markdownStale =
      this.markdownExportDocument !== document || this.markdownExportRevision < revision;
    const treeStale =
      includeTreeJson &&
      (this.treeExportDocument !== document || this.treeExportRevision < revision);
    if (!markdownStale && !treeStale) return;

    const cachedTree = this.canonicalTreeCache;
    const exportedTree =
      cachedTree?.document === document && cachedTree.revision === revision
        ? cachedTree.tree
        : document.exportMarkdownTree();
    if (document !== this.canonicalDocument || document.acceptedRevision !== revision) {
      this.scheduleCanonicalExports(document.acceptedRevision);
      return;
    }
    this.canonicalTreeCache = { document, revision, tree: exportedTree };
    if (markdownStale) {
      const markdown = serializeToString(exportedTree);
      this.source = markdown;
      this.serializedMarkdown = markdown;
      this.pendingText = '';
      this.parseMode = 'edited';
      this.playbackIndex = markdown.length;
      this.parserReusable = false;
      this.markdownExportDocument = document;
      this.markdownExportRevision = revision;
    }
    if (treeStale) {
      this.treeJson = JSON.stringify(exportedTree, null, 2);
      this.treeExportDocument = document;
      this.treeExportRevision = revision;
    }
    this.requestUpdate();
  }

  private onCanonicalHistoryReset = () => {
    this.historyStatus = 'Undo history was reset.';
    this.refreshToolbarHistoryAvailability();
  };

  private preserveControlFocus = (event: PointerEvent) => {
    if (event.button === 0) event.preventDefault();
  };

  private toggleSimulatedKeyboard = () => {
    this.simulatedKeyboard = !this.simulatedKeyboard;
    this.refreshKeyboardState();
  };

  private onFocusIn = (event: FocusEvent) => {
    const path = event.composedPath();
    const inline = path.find(
      (target): target is MarkdownInline => target instanceof MarkdownInline,
    );
    const toolbar = this.shadowRoot?.querySelector('md-mobile-keyboard-toolbar');
    if (inline && this.activeTab === 'render' && this.isCurrentEditorInline(inline)) {
      this.activeInline = inline;
      this.observeNativeSelection(inline);
      this.toolbarHasFocus = false;
      this.visualViewportBaseline = window.innerHeight;
      this.claimVirtualKeyboardOverlay();
      this.refreshToolbarReadiness();
      this.refreshKeyboardState();
    } else if (toolbar && path.includes(toolbar)) {
      this.toolbarHasFocus = true;
      this.restoreVirtualKeyboardOverlay();
      this.refreshToolbarReadiness();
    } else {
      this.clearEditingTarget();
    }
  };

  private onFocusOut = () => {
    window.setTimeout(() => this.reconcileFocus(), 0);
  };

  private onToolbarFocusChange = (event: MobileToolbarFocusEvent) => {
    if (event.detail.focused) {
      this.toolbarHasFocus = true;
      this.restoreVirtualKeyboardOverlay();
      this.refreshToolbarReadiness();
    } else {
      window.setTimeout(() => this.reconcileFocus(), 0);
    }
  };

  private reconcileFocus() {
    const editor = this.activeEditor();
    const inline = editor ? this.findFocusedInline(editor) : undefined;
    if (inline) {
      this.activeInline = inline;
      this.observeNativeSelection(inline);
      this.toolbarHasFocus = false;
      this.claimVirtualKeyboardOverlay();
      this.refreshToolbarReadiness();
      this.refreshKeyboardState();
      return;
    }

    const toolbar = this.shadowRoot?.querySelector('md-mobile-keyboard-toolbar');
    const activeElement = this.deepActiveElement(this.shadowRoot);
    if (toolbar && activeElement && this.isComposedDescendant(activeElement, toolbar)) {
      this.toolbarHasFocus = true;
      this.restoreVirtualKeyboardOverlay();
      this.refreshToolbarReadiness();
      return;
    }
    this.clearEditingTarget();
  }

  private activeEditor() {
    return this.activeTab === 'render'
      ? this.shadowRoot?.querySelector('md-canonical-editor')
      : undefined;
  }

  private findFocusedInline(editor: HTMLElement): MarkdownInline | undefined {
    const inspect = (root: ParentNode): MarkdownInline | undefined => {
      for (const element of root.querySelectorAll('*')) {
        if (element instanceof MarkdownInline && element.matches(':focus')) return element;
        if (element.shadowRoot) {
          const nested = inspect(element.shadowRoot);
          if (nested) return nested;
        }
      }
      return;
    };
    return editor.shadowRoot ? inspect(editor.shadowRoot) : undefined;
  }

  private isCurrentEditorInline(inline: MarkdownInline) {
    const editor = this.activeEditor();
    return !!editor && inline.isConnected && this.isComposedDescendant(inline, editor);
  }

  private isComposedDescendant(node: Node, ancestor: Node) {
    let current: Node | null = node;
    while (current && current !== ancestor) {
      if (current.parentNode) current = current.parentNode;
      else {
        const root = current.getRootNode();
        current = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return current === ancestor;
  }

  private deepActiveElement(root: Document | ShadowRoot | null | undefined): Element | null {
    let active = root?.activeElement ?? null;
    while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  private getActionTarget() {
    const editor = this.activeEditor();
    if (!editor) return;
    const focused = this.findFocusedInline(editor);
    if (focused) {
      this.activeInline = focused;
      this.toolbarHasFocus = false;
      return focused;
    }
    const toolbar = this.shadowRoot?.querySelector('md-mobile-keyboard-toolbar');
    if (
      this.toolbarHasFocus &&
      toolbar &&
      this.activeInline &&
      this.activeInline.isConnected &&
      this.isComposedDescendant(this.activeInline, editor)
    ) {
      return this.activeInline;
    }
  }

  private clearEditingTarget() {
    this.activeInline = undefined;
    this.toolbarHasFocus = false;
    this.clearReadinessTimer();
    this.toolbarVisible = false;
    this.toolbarDisabled = true;
    this.toolbarUndoDisabled = true;
    this.toolbarRedoDisabled = true;
    this.keyboardHeight = 0;
    this.style.setProperty('--mobile-keyboard-reserve', '0px');
    this.stopObservingNativeSelection();
    this.stopObservingVirtualKeyboard();
  }

  private refreshToolbarReadiness() {
    const inline = this.getActionTarget();
    const ready = !!inline?.mobileToolbarInputReady;
    this.toolbarDisabled = !ready;
    this.refreshToolbarHistoryAvailability(inline);
    if (inline && !ready && !inline.composing) this.waitForReadiness(inline);
    else this.clearReadinessTimer();
  }

  private refreshToolbarHistoryAvailability(inline = this.getActionTarget()) {
    const root = inline?.hostContext?.root;
    if (!root) {
      this.toolbarUndoDisabled = true;
      this.toolbarRedoDisabled = true;
      return;
    }
    const writer = this.canonicalWriter;
    if (writer) {
      this.toolbarUndoDisabled = !writer.canUndo('local');
      this.toolbarRedoDisabled = !writer.canRedo('local');
      return;
    }
    if (!(viewModel in root)) {
      this.toolbarUndoDisabled = true;
      this.toolbarRedoDisabled = true;
      return;
    }
    const legacyRoot = root as ViewModelNode;
    const tree = legacyRoot[viewModel].tree;
    this.toolbarUndoDisabled = !tree.canUndo(legacyRoot);
    this.toolbarRedoDisabled = !tree.canRedo(legacyRoot);
  }

  private waitForReadiness(inline: MarkdownInline) {
    if (this.readinessTimer !== undefined) return;
    this.readinessTimer = window.setInterval(() => {
      if (!inline.isConnected || this.getActionTarget() !== inline) {
        this.clearReadinessTimer();
        this.refreshToolbarReadiness();
        return;
      }
      if (inline.mobileToolbarInputReady) {
        this.clearReadinessTimer();
        this.toolbarDisabled = false;
      }
    }, 16);
  }

  private clearReadinessTimer() {
    if (this.readinessTimer === undefined) return;
    window.clearInterval(this.readinessTimer);
    this.readinessTimer = undefined;
  }

  private onCompositionChange = (event: Event) => {
    const inline = event
      .composedPath()
      .find((target): target is MarkdownInline => target instanceof MarkdownInline);
    if (!inline || inline !== this.activeInline) return;
    this.refreshToolbarReadiness();
  };

  private onEditorInput = () => this.scheduleCaretVisibilityCheck();
  private onEditorKeydown = () => this.scheduleCaretVisibilityCheck();

  private observeNativeSelection(inline: MarkdownInline) {
    const document = inline.ownerDocument;
    const root = inline.getRootNode();
    const shadowRoot = root instanceof ShadowRoot ? root : undefined;
    if (this.selectionChangeDocument === document && this.selectionChangeRoot === shadowRoot)
      return;
    this.stopObservingNativeSelection();
    this.selectionChangeDocument = document;
    this.selectionChangeRoot = shadowRoot;
    document.addEventListener('selectionchange', this.onNativeSelectionChange);
    shadowRoot?.addEventListener('selectionchange', this.onNativeSelectionChange);
  }

  private stopObservingNativeSelection() {
    this.selectionChangeDocument?.removeEventListener(
      'selectionchange',
      this.onNativeSelectionChange,
    );
    this.selectionChangeRoot?.removeEventListener('selectionchange', this.onNativeSelectionChange);
    this.selectionChangeDocument = undefined;
    this.selectionChangeRoot = undefined;
  }

  private onNativeSelectionChange = () => {
    if (this.toolbarVisible && this.getActionTarget()) this.scheduleCaretVisibilityCheck();
  };

  private onMobileToolbarAction = (event: MobileToolbarActionEvent) => {
    const inline = this.getActionTarget();
    if (!inline?.mobileToolbarInputReady || !inline.nodeView) {
      this.refreshToolbarReadiness();
      return;
    }
    const restoreFocusAfterActivation = this.toolbarHasFocus;
    inline.focus({ preventScroll: true });
    if (!inline.mobileToolbarInputReady) {
      this.refreshToolbarReadiness();
      return;
    }
    this.sendToolbarAction(inline, event.detail.action);
    this.refreshToolbarReadiness();
    this.scheduleCaretVisibilityCheck();
    if (restoreFocusAfterActivation) {
      requestAnimationFrame(() => {
        const editor = this.activeEditor();
        const current = editor ? this.findFocusedInline(editor) : undefined;
        const target = current ?? this.getActionTarget();
        if (target?.mobileToolbarInputReady && this.isCurrentEditorInline(target)) {
          target.focus({ preventScroll: true });
          this.activeInline = target;
          this.toolbarHasFocus = false;
          this.claimVirtualKeyboardOverlay();
          this.refreshToolbarReadiness();
          this.refreshKeyboardState();
        }
      });
    }
  };

  private sendToolbarAction(inline: MarkdownInline, action: MobileToolbarAction) {
    const sendKey = (key: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
      inline.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          ...modifiers,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    };
    if (action === 'split') {
      inline.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertLineBreak',
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      return;
    }
    if (action === 'select-all') {
      if (!inline.hostContext?.hasSelection) {
        const selection = this.getNativeSelection(inline);
        if (!selection) return;
        const range = inline.ownerDocument.createRange();
        range.selectNodeContents(inline);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      sendKey('a', { ctrlKey: true });
      return;
    }
    const keyMap: Record<
      Exclude<MobileToolbarAction, 'split' | 'select-all'>,
      { key: string; shiftKey?: boolean; ctrlKey?: boolean }
    > = {
      unindent: { key: 'Tab', shiftKey: true },
      indent: { key: 'Tab' },
      'extend-up': { key: 'ArrowUp', ctrlKey: true, shiftKey: true },
      'extend-down': { key: 'ArrowDown', ctrlKey: true, shiftKey: true },
      undo: { key: 'z', ctrlKey: true },
      redo: { key: 'y', ctrlKey: true },
      left: { key: 'ArrowLeft' },
      right: { key: 'ArrowRight' },
      up: { key: 'ArrowUp' },
      down: { key: 'ArrowDown' },
    };
    sendKey(keyMap[action].key, keyMap[action]);
  }

  private getNativeSelection(inline: MarkdownInline) {
    const root = inline.getRootNode() as (Document | ShadowRoot) & {
      getSelection?: () => Selection | null;
    };
    return typeof root.getSelection === 'function' ? root.getSelection() : document.getSelection();
  }

  private toggleVirtualKeyboardOverlay() {
    const api = getVirtualKeyboard();
    if (!api) return;
    this.observeVirtualKeyboard();
    if (this.previousOverlayContent === undefined)
      this.previousOverlayContent = api.overlaysContent;
    api.overlaysContent = true;
  }

  private observeVirtualKeyboard() {
    const api = getVirtualKeyboard();
    if (this.observedKeyboardApi === api) return;
    this.stopObservingVirtualKeyboard();
    if (!api) return;
    this.observedKeyboardApi = api;
    api.addEventListener('geometrychange', this.onVirtualKeyboardGeometryChange);
  }

  private claimVirtualKeyboardOverlay() {
    if (this.activeTab !== 'render' || !this.activeInline?.matches(':focus')) return;
    this.toggleVirtualKeyboardOverlay();
  }

  private restoreVirtualKeyboardOverlay() {
    if (this.observedKeyboardApi && this.previousOverlayContent !== undefined) {
      this.observedKeyboardApi.overlaysContent = this.previousOverlayContent;
    }
    this.previousOverlayContent = undefined;
  }

  private stopObservingVirtualKeyboard() {
    this.restoreVirtualKeyboardOverlay();
    this.observedKeyboardApi?.removeEventListener(
      'geometrychange',
      this.onVirtualKeyboardGeometryChange,
    );
    this.observedKeyboardApi = undefined;
  }

  private onVirtualKeyboardGeometryChange = () => this.refreshKeyboardState();

  private onViewportChange = () => this.refreshKeyboardState();

  private onOrientationChange = () => {
    this.visualViewportBaseline = window.innerHeight;
    this.refreshKeyboardState();
  };

  private refreshKeyboardState() {
    const inline = this.getActionTarget();
    this.refreshToolbarReadiness();
    if (!inline || this.activeTab !== 'render') {
      this.toolbarVisible = false;
      this.keyboardHeight = 0;
      this.style.setProperty('--mobile-keyboard-reserve', '0px');
      return;
    }
    if (inline.matches(':focus')) this.claimVirtualKeyboardOverlay();

    let keyboardTop = 0;
    let keyboardHeight = 0;
    if (this.simulatedKeyboard) {
      keyboardHeight = Math.min(280, window.innerHeight);
      keyboardTop = Math.max(0, window.innerHeight - keyboardHeight);
    } else if (getVirtualKeyboard()) {
      const rect = getVirtualKeyboard()!.boundingRect;
      keyboardHeight = Math.max(0, rect.height);
      keyboardTop = rect.top;
    } else {
      const viewport = window.visualViewport;
      const currentHeight = viewport?.height ?? window.innerHeight;
      const hiddenHeight = this.visualViewportBaseline - currentHeight;
      if (hiddenHeight >= 120) {
        keyboardHeight = hiddenHeight;
        keyboardTop = (viewport?.offsetTop ?? 0) + currentHeight;
      }
    }

    this.keyboardHeight = keyboardHeight;
    this.toolbarVisible = keyboardHeight > 0;
    this.keyboardTop = keyboardTop;
    this.toolbarTop = Math.max(0, keyboardTop - 56);
    this.style.setProperty(
      '--mobile-keyboard-reserve',
      keyboardHeight > 0 ? `${keyboardHeight + 68}px` : '0px',
    );
    if (this.toolbarVisible) this.scheduleCaretVisibilityCheck();
  }

  private scheduleCaretVisibilityCheck() {
    if (this.caretFrame !== undefined) cancelAnimationFrame(this.caretFrame);
    this.caretFrame = requestAnimationFrame(() => {
      this.caretFrame = undefined;
      this.keepCaretVisible();
    });
  }

  private keepCaretVisible() {
    const inline = this.getActionTarget();
    if (!inline || !inline.isConnected) return;
    try {
      const caretBottom = inline.getCaretPosition().y;
      const visibleBottom = this.toolbarVisible
        ? this.toolbarTop
        : (window.visualViewport?.offsetTop ?? 0) +
          (window.visualViewport?.height ?? window.innerHeight);
      if (caretBottom > visibleBottom - 12) {
        window.scrollBy(0, caretBottom - visibleBottom + 28);
      }
    } catch {
      // A collapsed native selection may not have a measurable caret yet.
    }
  }

  private observeRootTree(tree: MarkdownTree | undefined) {
    if (this.observedTree === tree) return;
    this.observedTree?.removeEventListener('tree-change', this.onTreeChange);
    this.observedTree?.removeEventListener('history-change', this.onHistoryChange);
    this.observedTree = tree;
    this.observedTree?.addEventListener('tree-change', this.onTreeChange);
    this.observedTree?.addEventListener('history-change', this.onHistoryChange);
    this.refreshToolbarHistoryAvailability();
  }

  private onHistoryChange = () => this.refreshToolbarHistoryAvailability();

  private onTreeChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== 'edit') return;
    if (!this.root) return;
    this.refreshToolbarHistoryAvailability();
    this.stopPlayback();
    const serializedTree = this.root[viewModel].tree.serialize();
    this.source = serializeToString(serializedTree);
    this.serializedMarkdown = this.source;
    this.treeJson = JSON.stringify(serializedTree, null, 2);
    this.pendingText = '';
    this.parseMode = 'edited';
    this.playbackIndex = this.source.length;
    this.parserReusable = false;
    this.requestUpdate();
  };
}

customElements.define('md-dev-harness', MarkdownDevHarness);
