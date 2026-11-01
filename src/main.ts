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
      display: block;
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
      min-height: 100vh;
      color: var(--root-color);
      background: color-mix(in srgb, var(--root-background-color) 96%, var(--root-color));
      font:
        15px/1.5 'Iowan Old Style',
        'Palatino Linotype',
        'Book Antiqua',
        Palatino,
        Georgia,
        serif;
    }

    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem 1rem;
      box-sizing: border-box;
      max-width: 1440px;
      margin: 0 auto;
      padding: 1rem clamp(1rem, 3vw, 2rem);
      border-bottom: 1px solid color-mix(in srgb, var(--root-color) 12%, transparent);
      background: color-mix(in srgb, var(--root-background-color) 88%, transparent);
    }

    .brand {
      margin: 0;
      color: var(--root-color);
      font:
        650 1.1rem/1.2 system-ui,
        sans-serif;
      letter-spacing: -0.025em;
    }

    .header-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .source-toggle,
    .tools-toggle,
    .simulation-toggle,
    .play {
      min-height: 40px;
      border: 1px solid color-mix(in srgb, var(--root-color) 16%, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, var(--root-background-color) 94%, var(--root-color));
      color: var(--root-color);
      padding: 0.6rem 0.85rem;
      font:
        500 0.84rem/1.1 system-ui,
        sans-serif;
      cursor: pointer;
    }

    .source-toggle:hover,
    .tools-toggle:hover,
    .simulation-toggle:hover {
      background: color-mix(in srgb, var(--md-active-block-color) 70%, transparent);
    }

    .source-toggle:focus-visible,
    .tools-toggle:focus-visible,
    .simulation-toggle:focus-visible,
    .play:focus-visible,
    .tab:focus-visible,
    input:focus-visible {
      outline: 2px solid var(--md-accent-color);
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
      box-sizing: border-box;
      max-width: 1440px;
      margin: 0 auto;
      padding: 1rem clamp(1rem, 3vw, 2rem);
      border-bottom: 1px solid color-mix(in srgb, var(--root-color) 12%, transparent);
      background: color-mix(in srgb, var(--root-background-color) 90%, var(--root-color));
      font:
        0.82rem/1.4 system-ui,
        sans-serif;
    }

    .tools-panel[hidden],
    .source-pane[hidden] {
      display: none;
    }

    .playback-controls {
      display: grid;
      grid-template-columns: auto minmax(10rem, 1fr) auto auto;
      align-items: center;
      gap: 0.85rem;
    }

    .play {
      border-color: var(--md-accent-color);
      background: var(--md-accent-color);
      color: var(--root-background-color);
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
      color: color-mix(in srgb, var(--root-color) 72%, transparent);
    }

    input[type='range'] {
      width: 100%;
      accent-color: var(--md-accent-color);
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 0.55rem 1rem;
      flex-wrap: wrap;
      margin: 0;
      font-size: 0.78rem;
    }

    .simulation-toggle {
      justify-self: start;
      border-style: dashed;
    }

    .simulation-toggle[aria-pressed='true'] {
      border-style: solid;
      color: var(--md-accent-color);
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(250px, 0.36fr) minmax(0, 0.64fr);
      min-width: 0;
      min-height: calc(100vh - 68px);
      max-width: 1440px;
      margin: 0 auto;
      padding-bottom: var(--mobile-keyboard-reserve, 0px);
    }

    .shell.source-collapsed {
      grid-template-columns: minmax(0, 1fr);
    }

    .panel {
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      min-width: 0;
      padding: clamp(1rem, 2.4vw, 2rem);
    }

    .editor {
      min-height: 0;
      border-right: 1px solid color-mix(in srgb, var(--root-color) 10%, transparent);
      background: color-mix(in srgb, var(--root-background-color) 84%, transparent);
      backdrop-filter: blur(18px);
    }

    .preview {
      min-height: 0;
      background: color-mix(in srgb, var(--root-background-color) 92%, transparent);
    }

    .label {
      display: block;
      margin: 0;
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
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      resize: vertical;
      border: 1px solid color-mix(in srgb, var(--root-color) 14%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--root-background-color) 94%, transparent);
      padding: 1rem 1.05rem;
      color: var(--root-color);
      font:
        14px/1.55 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }

    .source-pane {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      min-height: 0;
    }

    .preview .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin: 0;
      padding-bottom: 0.55rem;
      border-bottom: 1px solid color-mix(in srgb, var(--root-color) 12%, transparent);
    }

    .tab {
      border: 0;
      border-radius: 7px 7px 0 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: color-mix(in srgb, var(--root-color) 70%, transparent);
      padding: 0.55rem 0.8rem;
      font:
        550 0.84rem/1 system-ui,
        sans-serif;
      cursor: pointer;
    }

    .tab:hover {
      background: color-mix(in srgb, var(--md-active-block-color) 55%, transparent);
    }

    .tab[selected] {
      border-bottom-color: var(--md-accent-color);
      color: var(--root-color);
      font-weight: 650;
    }

    .preview-card {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
      min-height: 0;
      padding: 0.25rem 0 1rem;
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
      border-top: 1px solid color-mix(in srgb, var(--root-color) 20%, transparent);
      border-radius: 14px 14px 0 0;
      background: color-mix(in srgb, var(--root-background-color) 88%, var(--root-color));
      box-shadow: 0 -8px 28px rgb(0 0 0 / 12%);
      color: var(--root-color);
      font:
        12px/1.2 system-ui,
        sans-serif;
    }

    .simulated-keyboard[hidden] {
      display: none;
    }

    .keyboard-label {
      text-align: center;
      color: color-mix(in srgb, var(--root-color) 70%, transparent);
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
      background: color-mix(in srgb, var(--root-background-color) 96%, var(--root-color));
      box-shadow: 0 1px 2px rgb(0 0 0 / 14%);
      font-size: 0.8rem;
    }

    .key-row .wide-key {
      max-width: 6rem;
      background: color-mix(in srgb, var(--md-active-block-color) 72%, transparent);
    }

    .serialized {
      width: 100%;
      min-height: 45vh;
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
      min-height: 45vh;
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
      .app-header {
        padding: 0.75rem 1rem;
      }

      .header-actions {
        width: 100%;
      }

      .source-toggle,
      .tools-toggle {
        flex: 1 1 auto;
      }

      .tools-panel {
        gap: 0.75rem;
      }

      .playback-controls {
        grid-template-columns: auto minmax(0, 1fr);
        gap: 0.7rem;
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
        min-height: 0;
      }

      .editor {
        border-right: 0;
        border-bottom: 1px solid color-mix(in srgb, var(--root-color) 8%, transparent);
        min-height: 18rem;
      }

      textarea {
        min-height: 13rem;
      }

      .preview {
        min-height: 62vh;
      }

      .preview-card {
        min-height: 55vh;
      }
    }

    @media (max-width: 420px) {
      .app-header {
        gap: 0.6rem;
      }

      .playback-delay {
        font-size: 0.72rem;
      }

      .tab {
        padding-right: 0.65rem;
        padding-left: 0.65rem;
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
    this.sourceExpanded = true;
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
      <header class="app-header">
        <h1 class="brand">Grain</h1>
        <nav class="header-actions" aria-label="Harness panels">
          <button
            class="source-toggle"
            aria-controls="source-pane"
            aria-expanded=${this.sourceExpanded}
            @click=${this.toggleSource}
          >
            Source
          </button>
          <button
            class="tools-toggle"
            aria-controls="test-tools-panel"
            aria-expanded=${this.testToolsExpanded}
            @click=${this.toggleTestTools}
          >
            Test tools
          </button>
        </nav>
      </header>
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
        <section id="source-pane" class="panel editor source-pane" ?hidden=${!this.sourceExpanded}>
          <label class="label" for="source">Markdown Source</label>
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
    this.sourceExpanded = !this.sourceExpanded;
  };

  private toggleTestTools = () => {
    this.testToolsExpanded = !this.testToolsExpanded;
  };

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
    this.stopObservingNativeSelection();
    this.stopObservingVirtualKeyboard();
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
