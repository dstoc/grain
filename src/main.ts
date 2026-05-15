import {LitElement, css, html} from 'lit';

import './markdown/block-render.js';
import {createBlockParser} from './markdown/block-parser.js';
import type {BlockParser} from './markdown/block-parser.js';
import type {ViewModelNode} from './markdown/view-model-node.js';

const sample = `# Block Harness
This is a minimal browser harness for block rendering.

## Lists
- one
- [ ] two
- [x] three

## Quote
> This keeps the render path focused on block structure.

Plain text still renders inline content as raw text for now.`;

class MarkdownDevHarness extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      color: #111827;
      background:
        radial-gradient(circle at top left, rgba(13, 148, 136, 0.12), transparent 28%),
        linear-gradient(180deg, #fcfcf9 0%, #f3f4ef 100%);
      font: 15px/1.5 "Iowan Old Style", "Palatino Linotype", "Book Antiqua",
        Palatino, Georgia, serif;
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
      border-right: 1px solid rgba(17, 24, 39, 0.08);
      background: rgba(255, 255, 255, 0.58);
      backdrop-filter: blur(18px);
    }

    .preview {
      background: rgba(252, 252, 249, 0.92);
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
      color: #4b5563;
    }

    .label {
      display: block;
      margin-bottom: 0.55rem;
      color: #0f766e;
      font: 600 0.78rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    textarea {
      width: 100%;
      min-height: 68vh;
      resize: vertical;
      border: 1px solid rgba(17, 24, 39, 0.14);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.86);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
      padding: 1rem 1.05rem;
      color: #111827;
      font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    textarea:focus {
      outline: 2px solid rgba(15, 118, 110, 0.25);
      outline-offset: 2px;
    }

    .meta {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-top: 0.85rem;
      color: #6b7280;
      font-size: 0.9rem;
    }

    .preview-card {
      min-height: 68vh;
      border: 1px solid rgba(17, 24, 39, 0.08);
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.86);
      box-shadow:
        0 24px 60px rgba(17, 24, 39, 0.08),
        inset 0 1px 0 rgba(255, 255, 255, 0.65);
      padding: 1.35rem 1.35rem 1.6rem;
    }

    @media (max-width: 920px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .editor {
        border-right: 0;
        border-bottom: 1px solid rgba(17, 24, 39, 0.08);
      }

      textarea,
      .preview-card {
        min-height: 42vh;
      }
    }
  `;
  static override properties = {
    root: {attribute: false},
    source: {state: true},
    pendingText: {state: true},
    parseMode: {state: true},
    renderVersion: {state: true},
  };

  declare root: ViewModelNode | undefined;
  private declare source: string;
  private declare pendingText: string;
  private declare parseMode: string;
  private declare renderVersion: number;
  private parser: BlockParser;

  constructor() {
    super();
    this.parser = createBlockParser();
    this.root = undefined;
    this.source = sample;
    this.pendingText = '';
    this.parseMode = 'initial';
    this.renderVersion = 0;
    this.reparse(sample, true);
  }

  override render() {
    return html`
      <main class="shell">
        <section class="panel editor">
          <h1>Block Render Harness</h1>
          <p class="lede">
            This page reparses markdown on every input change using the new
            chunk-based block parser and renders only block structure.
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
        </section>
        <section class="panel preview">
          <label class="label">Rendered Blocks</label>
          <div class="preview-card">
            ${this.root
              ? html`<md-block-render
                  .block=${this.root}
                  .version=${this.renderVersion}
                ></md-block-render>`
              : html``}
          </div>
        </section>
      </main>
    `;
  }

  private onInput = (event: Event) => {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    this.reparse(value);
  };

  private reparse(markdown: string, forceFull = false) {
    if (!forceFull && markdown.startsWith(this.source)) {
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

    const tree = this.parser.getTree();
    this.root = tree.root;
    this.pendingText = this.parser.getPendingText();
    this.renderVersion++;
  }
}

customElements.define('md-dev-harness', MarkdownDevHarness);
