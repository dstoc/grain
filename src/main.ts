import { LitElement, css, html } from 'lit';

import './editing/editor.js';
import './markdown/transclusion.js';
import { createBlockParser, parseMarkdownTree } from './markdown/block-parser/api.js';
import type { BlockParser } from './markdown/block-parser/api.js';
import { serializeToString } from './markdown/block-serializer.js';
import type { MarkdownRenderDelegate } from './markdown/render-delegate.js';
import { viewModel } from './markdown/view-model-node.js';
import type { ViewModelNode } from './markdown/view-model-node.js';
import type { MarkdownTree } from './markdown/view-model.js';
import { styles as appStyles } from './style.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, ...appStyles];

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

class MarkdownDevHarness extends LitElement {
  static override styles = css`
    :host {
      display: block;
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
      grid-template-columns: minmax(300px, 0.92fr) minmax(320px, 1.08fr);
      min-height: 100vh;
    }

    .panel {
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
      min-height: 68vh;
      border: 1px solid color-mix(in srgb, var(--root-color) 8%, transparent);
      border-radius: 24px;
      background: color-mix(in srgb, var(--root-background-color) 90%, transparent);
      box-shadow:
        0 24px 60px color-mix(in srgb, var(--root-color) 8%, transparent),
        inset 0 1px 0 color-mix(in srgb, var(--root-background-color) 65%, white);
      padding: 1.35rem 1.35rem 1.6rem;
    }

    .tabs {
      display: inline-flex;
      gap: 0.45rem;
      margin-bottom: 0.85rem;
      padding: 0.2rem;
      border-radius: 999px;
      background: color-mix(in srgb, var(--root-color) 6%, transparent);
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
        grid-template-columns: 1fr;
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
    activeTab: { state: true },
    serializedMarkdown: { state: true },
    treeJson: { state: true },
  };

  declare root: ViewModelNode | undefined;
  declare private source: string;
  declare private pendingText: string;
  declare private parseMode: string;
  declare private playbackIndex: number;
  declare private playing: boolean;
  declare private renderVersion: number;
  declare private activeTab: 'render' | 'serialize' | 'tree';
  declare private serializedMarkdown: string;
  declare private treeJson: string;
  private parser: BlockParser;
  private observedTree: MarkdownTree | undefined;
  private parserDirtyFromRenderEdit = false;
  private playbackTimer: number | undefined;
  private readonly playbackDelayMs = 10;

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
    this.serializedMarkdown = '';
    this.treeJson = '';
    this.reparse(sample, true);
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
            @input=${this.onInput}
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
          </div>
          <div class="preview-card">
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
    `;
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

  private setTab(tab: 'render' | 'serialize' | 'tree') {
    this.activeTab = tab;
  }

  override disconnectedCallback(): void {
    this.observeRootTree(undefined);
    this.stopPlayback();
    super.disconnectedCallback();
  }

  protected override updated() {
    this.observeRootTree(this.root?.[viewModel].tree);
  }

  private startPlayback() {
    this.stopPlayback();
    this.playing = true;
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
    this.parser.finish();
    this.playbackIndex = this.source.length;
    this.parseMode = 'play-finished';
    this.updateFromParser();
  }

  private reparse(markdown: string, forceFull = false) {
    if (!forceFull && !this.parserDirtyFromRenderEdit && markdown.startsWith(this.source)) {
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

    this.parserDirtyFromRenderEdit = false;
    this.playbackIndex = this.source.length;
    this.updateFromParser();
  }

  private setPlaybackProgress(index: number, mode = 'scrub') {
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
      this.serializedMarkdown = serializeToString(serializedTree);
    }
    this.pendingText = this.parser.getPendingText();
    this.treeJson = JSON.stringify(serializedTree, null, 2);
    this.renderVersion++;
  }

  private observeRootTree(tree: MarkdownTree | undefined) {
    if (this.observedTree === tree) return;
    this.observedTree?.removeEventListener('tree-change', this.onTreeChange);
    this.observedTree = tree;
    this.observedTree?.addEventListener('tree-change', this.onTreeChange);
  }

  private onTreeChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== 'edit') return;
    if (!this.root) return;
    this.stopPlayback();
    const serializedTree = this.root[viewModel].tree.serialize();
    this.source = serializeToString(serializedTree);
    this.serializedMarkdown = this.source;
    this.treeJson = JSON.stringify(serializedTree, null, 2);
    this.pendingText = '';
    this.parseMode = 'edited';
    this.playbackIndex = this.source.length;
    this.parserDirtyFromRenderEdit = true;
    this.requestUpdate();
  };
}

customElements.define('md-dev-harness', MarkdownDevHarness);
