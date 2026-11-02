import { LitElement, css, html } from 'lit';

import './editing/editor.js';
import './editing/mobile-keyboard-toolbar.js';
import './markdown/transclusion.js';
import { MarkdownInline } from './markdown/inline-render.js';
import type {
  MobileToolbarAction,
  MobileToolbarActionEvent,
  MobileToolbarFocusEvent,
} from './editing/mobile-keyboard-toolbar.js';
import { createBlockParser, parseMarkdownTree } from './markdown/block-parser/api.js';
import type { BlockParser } from './markdown/block-parser/api.js';
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

const outputTabs = ['render', 'serialize', 'tree'] as const;
type OutputTab = (typeof outputTabs)[number];

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

class MarkdownDevHarness extends LitElement {
  static override styles = css`
    :host {
      --harness-page-background: #eef0eb;
      --harness-surface: #fff;
      --harness-panel: #f8f9f6;
      --harness-ink: #263229;
      --harness-muted: #758172;
      --harness-line: #dfe5d9;
      --harness-accent: #456e3b;
      --harness-selected: #e9f0e2;
      --harness-shadow: rgb(34 52 29 / 5%);
      display: flow-root;
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
      min-height: 100vh;
      color: var(--root-color);
      background: var(--harness-page-background);
      font:
        15px/1.5 'Iowan Old Style',
        'Palatino Linotype',
        'Book Antiqua',
        Palatino,
        Georgia,
        serif;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --harness-page-background: #151a17;
        --harness-surface: #1c231e;
        --harness-panel: #202822;
        --harness-ink: #e0e8db;
        --harness-muted: #9aa995;
        --harness-line: #354032;
        --harness-accent: #b1d69b;
        --harness-selected: #35452f;
        --harness-shadow: rgb(0 0 0 / 20%);
      }
    }

    .app-frame {
      --app-header-height: 64px;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      width: calc(100% - 48px);
      max-width: 1212px;
      height: calc(100vh - 48px);
      min-height: 520px;
      margin: 24px auto;
      overflow: hidden;
      border: 1px solid var(--harness-line);
      border-radius: 12px;
      background: var(--harness-surface);
      box-shadow: 0 12px 40px var(--harness-shadow);
    }

    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: none;
      gap: 1rem;
      box-sizing: border-box;
      height: 64px;
      padding: 0 20px;
      border-bottom: 1px solid var(--harness-line);
      background: var(--harness-surface);
      color: var(--harness-ink);
      font:
        14px/1.4 system-ui,
        sans-serif;
    }

    .brand {
      margin: 0;
      color: var(--harness-ink);
      font:
        650 1.375rem/1.2 system-ui,
        sans-serif;
      letter-spacing: -0.05em;
      white-space: nowrap;
    }

    .brand span {
      margin-left: 0.65rem;
      color: var(--harness-muted);
      font-size: 0.8125rem;
      font-weight: 400;
      letter-spacing: 0;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.45rem;
    }

    .source-toggle,
    .tools-toggle,
    .simulation-toggle,
    .play {
      min-height: 40px;
      border: 1px solid var(--harness-line);
      border-radius: 7px;
      background: var(--harness-surface);
      color: var(--harness-ink);
      padding: 0.55rem 0.75rem;
      font:
        500 0.75rem/1.1 system-ui,
        sans-serif;
      cursor: pointer;
    }

    .source-toggle:hover,
    .tools-toggle:hover,
    .simulation-toggle:hover,
    .source-toggle[aria-expanded='true'] {
      background: var(--harness-selected);
    }

    .source-toggle:focus-visible,
    .tools-toggle:focus-visible,
    .simulation-toggle:focus-visible,
    .play:focus-visible,
    .tab:focus-visible,
    input:focus-visible {
      outline: 2px solid var(--harness-accent);
      outline-offset: 2px;
    }

    .tools-toggle::after {
      display: inline-block;
      margin-left: 0.5rem;
      content: '⌄';
      transition: transform 120ms ease;
    }

    .tools-toggle[aria-expanded='true']::after {
      transform: rotate(180deg);
    }

    .tools-panel {
      display: grid;
      gap: 0.85rem;
      flex: none;
      box-sizing: border-box;
      padding: 0.9rem 20px;
      border-bottom: 1px solid var(--harness-line);
      background: var(--harness-panel);
      color: var(--harness-muted);
      font:
        0.75rem/1.4 system-ui,
        sans-serif;
    }

    .tools-panel[hidden],
    .source-pane[hidden] {
      display: none !important;
    }

    .playback-controls {
      display: grid;
      grid-template-columns: auto minmax(10rem, 1fr) auto auto;
      align-items: center;
      gap: 0.85rem;
    }

    .play {
      border-color: var(--harness-accent);
      background: var(--harness-accent);
      color: var(--harness-surface);
      font-weight: 650;
    }

    .play[disabled] {
      opacity: 0.55;
      cursor: default;
    }

    .slider-wrap {
      display: grid;
      grid-template-columns: auto minmax(4rem, 1fr);
      align-items: center;
      gap: 0.8rem;
      min-width: 0;
    }

    .slider-label,
    .playback-delay,
    .meta {
      color: var(--harness-muted);
    }

    input[type='range'] {
      width: 100%;
      accent-color: var(--harness-accent);
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 0.55rem 1rem;
      flex-wrap: wrap;
      margin: 0;
      font-size: 0.78rem;
    }

    .meta span {
      color: var(--harness-ink);
    }

    .simulation-toggle {
      justify-self: start;
      border-style: dashed;
    }

    .simulation-toggle[aria-pressed='true'] {
      border-style: solid;
      color: var(--harness-accent);
    }

    .panel-stack {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }

    .panel-stack.keyboard-visible {
      flex: 1 1 auto;
      max-height: calc(100% - var(--app-header-height) - var(--mobile-keyboard-reserve, 0px));
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .panel-stack.keyboard-visible .tools-panel {
      max-height: 112px;
      overflow-y: auto;
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(250px, 0.36fr) minmax(0, 0.64fr);
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
    }

    .shell.source-collapsed {
      grid-template-columns: minmax(0, 1fr);
    }

    .panel {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .editor {
      min-height: 0;
      border-right: 1px solid var(--harness-line);
      background: var(--harness-panel);
    }

    .preview {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      background: var(--root-background-color);
      color: var(--root-color);
    }

    .source-heading {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: space-between;
      height: 52px;
      padding: 0 clamp(14px, 1.6vw, 20px);
      border-bottom: 1px solid var(--harness-line);
    }

    .label {
      display: block;
      margin: 0;
      color: var(--harness-muted);
      font:
        600 0.625rem/1.2 system-ui,
        sans-serif;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .badge {
      border: 1px solid var(--harness-line);
      border-radius: 4px;
      padding: 3px 6px;
      color: var(--harness-muted);
      font:
        10px/1.2 system-ui,
        sans-serif;
    }

    textarea {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      resize: none;
      border: 0;
      background: var(--harness-panel);
      padding: 1rem clamp(14px, 1.6vw, 20px);
      color: var(--harness-ink);
      font:
        12px/1.85 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }

    .source-pane {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .preview .tabs {
      display: flex;
      flex: none;
      align-items: stretch;
      gap: 1rem;
      height: 52px;
      margin: 0;
      padding: 0 clamp(12px, 1.5vw, 18px);
      border-bottom: 1px solid var(--harness-line);
    }

    .tab {
      border: 0;
      border-radius: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--harness-muted);
      padding: 0 2px;
      font:
        550 0.75rem/1 system-ui,
        sans-serif;
      cursor: pointer;
    }

    .tab:hover {
      background: var(--harness-selected);
    }

    .tab[selected] {
      border-bottom-color: var(--harness-accent);
      color: var(--harness-ink);
      font-weight: 650;
    }

    .preview-card {
      flex: 1 1 0;
      min-width: 0;
      max-width: 100%;
      width: min(100%, 760px);
      box-sizing: border-box;
      min-height: 0;
      margin: 0 auto;
      overflow: auto;
      padding: clamp(1rem, 2.4vw, 1.5rem);
      color: var(--root-color);
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
      border-top: 1px solid var(--harness-line);
      border-radius: 14px 14px 0 0;
      background: var(--harness-panel);
      box-shadow: 0 -8px 28px rgb(0 0 0 / 12%);
      color: var(--harness-ink);
      font:
        12px/1.2 system-ui,
        sans-serif;
    }

    .simulated-keyboard[hidden] {
      display: none;
    }

    .keyboard-label {
      text-align: center;
      color: var(--harness-muted);
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
      background: var(--harness-surface);
      color: var(--harness-ink);
      box-shadow: 0 1px 2px rgb(0 0 0 / 14%);
      font-size: 0.8rem;
    }

    .key-row .wide-key {
      max-width: 6rem;
      background: var(--harness-selected);
    }

    .serialized {
      width: 100%;
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

    @media (max-width: 700px) {
      .app-frame {
        --app-header-height: 56px;
        width: calc(100% - 20px);
        height: calc(100dvh - 20px);
        min-height: 0;
        margin: 10px auto;
        border-radius: 9px;
      }

      .app-header {
        height: 56px;
        padding: 0 12px;
        gap: 0.6rem;
      }

      .header-actions {
        gap: 6px;
      }

      .source-toggle,
      .tools-toggle {
        min-height: 40px;
        padding-right: 0.65rem;
        padding-left: 0.65rem;
      }

      .tools-panel {
        gap: 0.75rem;
        padding: 12px;
      }

      .playback-controls {
        grid-template-columns: auto minmax(0, 1fr);
        gap: 8px;
      }

      .playback-delay {
        grid-column: 2;
      }

      .slider-wrap {
        grid-template-columns: 1fr;
        gap: 0.25rem;
      }

      .shell {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(144px, 1fr);
        min-height: 0;
      }

      .shell.source-expanded {
        grid-template-rows: minmax(96px, 0.42fr) minmax(144px, 1fr);
      }

      .editor {
        border-right: 0;
        border-bottom: 1px solid var(--harness-line);
      }

      .source-heading {
        height: 44px;
      }

      textarea {
        padding-top: 0.5rem;
        padding-bottom: 0.5rem;
      }

      .preview-card {
        padding: 1rem;
      }

      .preview .tabs {
        gap: 0.9rem;
      }
    }

    @media (max-width: 420px) {
      .app-header {
        gap: 0.45rem;
      }

      .brand span {
        display: none;
      }

      .playback-delay {
        font-size: 0.72rem;
      }

      .tab {
        padding-right: 0.15rem;
        padding-left: 0.15rem;
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
    activeTab: { state: true },
    sourceExpanded: { state: true },
    testToolsExpanded: { state: true },
    serializedMarkdown: { state: true },
    treeJson: { state: true },
    toolbarVisible: { state: true },
    toolbarDisabled: { state: true },
    toolbarUndoDisabled: { state: true },
    toolbarRedoDisabled: { state: true },
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
  declare private activeTab: OutputTab;
  declare private sourceExpanded: boolean;
  declare private testToolsExpanded: boolean;
  declare private serializedMarkdown: string;
  declare private treeJson: string;
  declare private toolbarVisible: boolean;
  declare private toolbarDisabled: boolean;
  declare private toolbarUndoDisabled: boolean;
  declare private toolbarRedoDisabled: boolean;
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
  private panelLayoutFrame: number | undefined;
  private availablePanelHeight = Number.POSITIVE_INFINITY;
  private readonly mobileLayoutQuery = window.matchMedia('(max-width: 700px)');
  private sourceManuallyToggled = false;

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
    this.activeTab = 'render';
    this.sourceExpanded = !this.mobileLayoutQuery.matches;
    this.testToolsExpanded = false;
    this.serializedMarkdown = '';
    this.treeJson = '';
    this.toolbarVisible = false;
    this.toolbarDisabled = true;
    this.toolbarUndoDisabled = true;
    this.toolbarRedoDisabled = true;
    this.toolbarTop = 0;
    this.simulatedKeyboard = false;
    this.keyboardTop = 0;
    this.reparse(sample, true);
    this.addEventListener('focusin', this.onFocusIn);
    this.addEventListener('focusout', this.onFocusOut);
    this.addEventListener('inline-input', this.onEditorInput);
    this.addEventListener('inline-keydown', this.onEditorKeydown);
    this.addEventListener('inline-composition-start', this.onCompositionChange);
    this.addEventListener('inline-composition-end', this.onCompositionChange);
    this.addEventListener('inline-projection-recovery', this.onCompositionChange);
  }

  override render() {
    return html`
      <div class="app-frame">
        <header class="app-header">
          <h1 class="brand">Grain <span>/ harness</span></h1>
          <nav class="header-actions" aria-label="Harness panels">
            <button
              class="source-toggle"
              aria-controls="source-pane"
              aria-expanded=${this.sourceExpanded}
              @pointerdown=${this.preserveControlFocus}
              @click=${this.toggleSource}
            >
              Source
            </button>
            <button
              class="tools-toggle"
              aria-controls="test-tools-panel"
              aria-expanded=${this.testToolsExpanded}
              @pointerdown=${this.preserveControlFocus}
              @click=${this.toggleTestTools}
            >
              Test tools
            </button>
          </nav>
        </header>
        <div class="panel-stack ${this.toolbarVisible ? 'keyboard-visible' : ''}">
          <section
            id="test-tools-panel"
            class="tools-panel"
            ?hidden=${!this.testToolsExpanded}
            aria-label="Parser and playback controls"
          >
            <div class="playback-controls">
              <button class="play" @click=${this.onPlayToggle}>
                ${this.playing ? 'Stop' : 'Play'}
              </button>
              <label class="slider-wrap">
                <span class="slider-label"
                  >Playback progress: ${this.playbackIndex}/${this.source.length}</span
                >
                <input
                  type="range"
                  aria-label="Playback progress"
                  min="0"
                  max=${String(this.source.length)}
                  step="1"
                  .value=${String(this.playbackIndex)}
                  @input=${this.onProgressInput}
                />
              </label>
              <span class="playback-delay"
                >Playback delay: ${this.playbackDelayMs} ms per character</span
              >
            </div>
            <div class="meta" aria-live="polite">
              <span>${this.source.length} chars</span>
              <span>${this.source.split('\n').length} lines</span>
              <span>pending tail: ${this.pendingText.length}</span>
              <span>mode: ${this.parseMode}</span>
            </div>
            <button
              class="simulation-toggle"
              aria-pressed=${this.simulatedKeyboard}
              @pointerdown=${this.preserveControlFocus}
              @click=${this.toggleSimulatedKeyboard}
            >
              ${this.simulatedKeyboard ? 'Hide simulated keyboard' : 'Show simulated keyboard'}
            </button>
          </section>
          <main class="shell ${this.sourceExpanded ? 'source-expanded' : 'source-collapsed'}">
            <section
              id="source-pane"
              class="panel editor source-pane"
              ?hidden=${!this.sourceExpanded}
            >
              <div class="source-heading">
                <label class="label" for="source">Markdown Source</label>
                <span class="badge">input</span>
              </div>
              <textarea
                id="source"
                .value=${this.source}
                @input=${this.onInput}
                spellcheck="false"
              ></textarea>
            </section>
            <section class="panel preview">
              <div class="tabs" role="tablist" aria-label="Output view">
                <button
                  class="tab"
                  id="render-tab"
                  role="tab"
                  aria-controls="output-panel"
                  aria-selected=${this.activeTab === 'render'}
                  tabindex=${this.activeTab === 'render' ? '0' : '-1'}
                  ?selected=${this.activeTab === 'render'}
                  @click=${() => this.setTab('render')}
                  @keydown=${this.onTabKeydown}
                >
                  Render
                </button>
                <button
                  class="tab"
                  id="serialize-tab"
                  role="tab"
                  aria-controls="output-panel"
                  aria-selected=${this.activeTab === 'serialize'}
                  tabindex=${this.activeTab === 'serialize' ? '0' : '-1'}
                  ?selected=${this.activeTab === 'serialize'}
                  @click=${() => this.setTab('serialize')}
                  @keydown=${this.onTabKeydown}
                >
                  Serialize
                </button>
                <button
                  class="tab"
                  id="tree-tab"
                  role="tab"
                  aria-controls="output-panel"
                  aria-selected=${this.activeTab === 'tree'}
                  tabindex=${this.activeTab === 'tree' ? '0' : '-1'}
                  ?selected=${this.activeTab === 'tree'}
                  @click=${() => this.setTab('tree')}
                  @keydown=${this.onTabKeydown}
                >
                  Tree
                </button>
              </div>
              <div
                id="output-panel"
                class="preview-card"
                role="tabpanel"
                tabindex="0"
                aria-labelledby="${this.activeTab}-tab"
              >
                ${
                  this.activeTab === 'render'
                    ? this.root
                      ? html`<md-editor
                          .root=${this.root}
                          .renderDelegate=${transclusionRenderDelegate}
                        ></md-editor>`
                      : html``
                    : this.activeTab === 'serialize'
                      ? html`<pre class="serialized">${this.serializedMarkdown}</pre>`
                      : html`<pre class="tree">${this.treeJson}</pre>`
                }
              </div>
            </section>
          </main>
        </div>
      </div>
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

  private toggleSource = () => {
    this.sourceManuallyToggled = true;
    const opening = !this.sourceExpanded;
    this.sourceExpanded = opening;
    if (opening && this.isCompactKeyboardLayout()) this.testToolsExpanded = false;
  };

  private onMobileLayoutChange = (event: MediaQueryListEvent) => {
    if (!this.sourceManuallyToggled) this.sourceExpanded = !event.matches;
  };

  private toggleTestTools = () => {
    const opening = !this.testToolsExpanded;
    this.testToolsExpanded = opening;
    if (opening && this.isCompactKeyboardLayout()) this.sourceExpanded = false;
  };

  private isCompactKeyboardLayout() {
    return this.toolbarVisible && this.availablePanelHeight < 410;
  }

  private onInput = (event: Event) => {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    this.stopPlayback();
    this.reparse(value);
  };

  private onProgressInput = (event: Event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    this.stopPlayback();
    this.setPlaybackProgress(value);
  };

  private onPlayToggle = () => {
    if (this.playing) {
      this.stopPlayback();
      return;
    }
    this.startPlayback();
  };

  private onTabKeydown = (event: KeyboardEvent) => {
    const currentIndex = outputTabs.indexOf(this.activeTab);
    let nextIndex: number;

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % outputTabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex + outputTabs.length - 1) % outputTabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = outputTabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const tab = outputTabs[nextIndex]!;
    this.setTab(tab);
    (event.currentTarget as HTMLButtonElement).parentElement
      ?.querySelector<HTMLButtonElement>(`#${tab}-tab`)
      ?.focus();
  };

  private setTab(tab: OutputTab) {
    this.activeTab = tab;
    if (tab !== 'render') this.clearEditingTarget();
    else this.refreshKeyboardState();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.mobileLayoutQuery.addEventListener('change', this.onMobileLayoutChange);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onOrientationChange);
    window.visualViewport?.addEventListener('resize', this.onViewportChange);
    window.visualViewport?.addEventListener('scroll', this.onViewportChange);
  }

  override disconnectedCallback(): void {
    this.observeRootTree(undefined);
    this.stopPlayback();
    this.mobileLayoutQuery.removeEventListener('change', this.onMobileLayoutChange);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onOrientationChange);
    window.visualViewport?.removeEventListener('resize', this.onViewportChange);
    window.visualViewport?.removeEventListener('scroll', this.onViewportChange);
    this.clearReadinessTimer();
    this.stopObservingNativeSelection();
    this.stopObservingVirtualKeyboard();
    if (this.panelLayoutFrame !== undefined) cancelAnimationFrame(this.panelLayoutFrame);
    super.disconnectedCallback();
  }

  protected override updated() {
    this.observeRootTree(this.root?.[viewModel].tree);
    this.schedulePanelLayoutUpdate();
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
  }

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
    return this.activeTab === 'render' ? this.shadowRoot?.querySelector('md-editor') : undefined;
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
    this.availablePanelHeight = Number.POSITIVE_INFINITY;
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
    const tree = root[viewModel].tree;
    this.toolbarUndoDisabled = !tree.canUndo(root);
    this.toolbarRedoDisabled = !tree.canRedo(root);
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
    if (!inline?.mobileToolbarInputReady || !inline.node) {
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
      this.availablePanelHeight = Number.POSITIVE_INFINITY;
      this.style.setProperty('--mobile-keyboard-reserve', '0px');
      void this.updateComplete.then(() => this.schedulePanelLayoutUpdate());
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
    void this.updateComplete.then(() => this.schedulePanelLayoutUpdate());
    if (this.toolbarVisible) this.scheduleCaretVisibilityCheck();
  }

  private schedulePanelLayoutUpdate() {
    if (!this.toolbarVisible) {
      if (this.panelLayoutFrame !== undefined) cancelAnimationFrame(this.panelLayoutFrame);
      this.panelLayoutFrame = undefined;
      this.availablePanelHeight = Number.POSITIVE_INFINITY;
      this.style.setProperty('--mobile-keyboard-reserve', '0px');
      return;
    }
    if (this.panelLayoutFrame !== undefined) return;

    this.panelLayoutFrame = requestAnimationFrame(() => {
      this.panelLayoutFrame = undefined;
      if (!this.toolbarVisible) return;

      const frame = this.shadowRoot?.querySelector<HTMLElement>('.app-frame');
      const toolbar = this.shadowRoot?.querySelector('md-mobile-keyboard-toolbar');
      if (!frame || !toolbar) return;

      const frameRect = frame.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      if (frameRect.height === 0 || toolbarRect.height === 0) return;

      const availableHeight = Math.max(0, toolbarRect.top - frameRect.top);
      const reserve = Math.max(0, frameRect.bottom - toolbarRect.top);
      this.availablePanelHeight = availableHeight;
      this.style.setProperty('--mobile-keyboard-reserve', `${reserve}px`);

      if (availableHeight < 410 && this.sourceExpanded && this.testToolsExpanded) {
        this.testToolsExpanded = false;
        return;
      }

      this.scheduleCaretVisibilityCheck();
    });
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
      const canvas = this.shadowRoot?.querySelector<HTMLElement>('.preview-card');
      if (!canvas) return;

      if (this.toolbarVisible) {
        const panelStack = this.shadowRoot?.querySelector<HTMLElement>('.panel-stack');
        const toolbar = this.shadowRoot?.querySelector('md-mobile-keyboard-toolbar');
        if (!panelStack || !toolbar) return;

        let stackRect = panelStack.getBoundingClientRect();
        let canvasRect = canvas.getBoundingClientRect();
        const visibleBottom = Math.min(stackRect.bottom, toolbar.getBoundingClientRect().top);
        if (canvasRect.bottom > visibleBottom) {
          panelStack.scrollTop += canvasRect.bottom - visibleBottom;
          stackRect = panelStack.getBoundingClientRect();
          canvasRect = canvas.getBoundingClientRect();
        }

        const visibleTop = Math.max(stackRect.top, canvasRect.top);
        const canvasVisibleBottom = Math.min(stackRect.bottom, toolbar.getBoundingClientRect().top);
        if (caretBottom > canvasVisibleBottom - 12) {
          canvas.scrollTop += caretBottom - canvasVisibleBottom + 28;
        } else if (caretBottom < visibleTop + 12) {
          canvas.scrollTop -= visibleTop - caretBottom + 28;
        }
      } else {
        const canvasRect = canvas.getBoundingClientRect();
        if (caretBottom > canvasRect.bottom - 12) {
          canvas.scrollTop += caretBottom - canvasRect.bottom + 28;
        } else if (caretBottom < canvasRect.top + 12) {
          canvas.scrollTop -= canvasRect.top - caretBottom + 28;
        }
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
