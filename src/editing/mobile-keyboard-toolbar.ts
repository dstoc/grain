import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type MobileToolbarAction =
  | 'unindent'
  | 'indent'
  | 'split'
  | 'select-all'
  | 'extend-up'
  | 'extend-down'
  | 'left'
  | 'right'
  | 'up'
  | 'down';

export interface MobileToolbarActionEvent extends CustomEvent<{ action: MobileToolbarAction }> {}
export interface MobileToolbarFocusEvent extends CustomEvent<{ focused: boolean }> {}

declare global {
  interface HTMLElementEventMap {
    'mobile-toolbar-action': MobileToolbarActionEvent;
    'mobile-toolbar-focus-change': MobileToolbarFocusEvent;
  }
}

const actions: Array<{
  id: MobileToolbarAction;
  label: string;
  icon: string;
  separator?: boolean;
}> = [
  { id: 'unindent', label: 'Unindent', icon: 'grain-out' },
  { id: 'indent', label: 'Indent', icon: 'grain-in' },
  { id: 'split', label: 'Insert paragraph or split block', icon: 'grain-split', separator: true },
  { id: 'select-all', label: 'Select all and promote block selection', icon: 'grain-all' },
  { id: 'extend-up', label: 'Extend block selection upward', icon: 'grain-extendup' },
  {
    id: 'extend-down',
    label: 'Extend block selection downward',
    icon: 'grain-extenddown',
    separator: true,
  },
  { id: 'left', label: 'Move caret left', icon: 'grain-left' },
  { id: 'right', label: 'Move caret right', icon: 'grain-right' },
  { id: 'up', label: 'Move caret up', icon: 'grain-up' },
  { id: 'down', label: 'Move caret down', icon: 'grain-down' },
];

@customElement('md-mobile-keyboard-toolbar')
export class MobileKeyboardToolbar extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      top: var(--toolbar-top, 0px);
      z-index: 1001;
      right: 0;
      left: 0;
      display: block;
      color: #334432;
      font:
        16px/1.2 system-ui,
        sans-serif;
      -webkit-tap-highlight-color: transparent;
    }

    :host(:not([visible])) {
      display: none;
    }

    .strip {
      display: flex;
      width: min(100%, 560px);
      min-height: 56px;
      margin: 0 auto;
      padding: 4px 6px;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
      touch-action: pan-x;
      background: #fbfcf9;
      border-top: 1px solid #d5dbd1;
      border-bottom: 1px solid #d5dbd1;
      box-shadow: 0 -4px 16px rgb(0 0 0 / 8%);
    }

    .strip::-webkit-scrollbar {
      display: none;
    }

    button {
      display: grid;
      flex: 0 0 48px;
      width: 48px;
      min-width: 48px;
      height: 48px;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      touch-action: manipulation;
    }

    button:hover:not(:disabled) {
      background: #e9eee5;
    }

    button:focus-visible {
      outline: 2px solid #67f;
      outline-offset: -2px;
    }

    button:disabled {
      color: #889186;
      cursor: not-allowed;
    }

    button svg {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.7;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .separator {
      flex: 0 0 1px;
      align-self: center;
      height: 28px;
      margin: 0 6px;
      background: #dce1d7;
    }

    .symbols {
      position: absolute;
      width: 0;
      height: 0;
      overflow: hidden;
    }
  `;

  @property({ type: Boolean, reflect: true }) accessor visible = false;
  @property({ type: Boolean }) accessor disabled = true;
  override render() {
    return html`
      <svg class="symbols" aria-hidden="true">
        <symbol id="grain-out" viewBox="0 0 24 24">
          <path d="M10 4h10M10 10h10M10 16h10M10 22h10M7 8l-5 5 5 5" />
        </symbol>
        <symbol id="grain-in" viewBox="0 0 24 24">
          <path d="M10 4h10M10 10h10M10 16h10M10 22h10M2 8l5 5-5 5" />
        </symbol>
        <symbol id="grain-split" viewBox="0 0 24 24">
          <path d="M4 4h16v5H4zM4 19h16M12 11v6m-3-3 3 3 3-3" />
        </symbol>
        <symbol id="grain-all" viewBox="0 0 24 24">
          <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M7 9h10M7 13h10M7 17h10" />
        </symbol>
        <symbol id="grain-extendup" viewBox="0 0 24 24">
          <path d="M3 13h11v8H3zM8 10V2m-3 3 3-3 3 3M18 6h3M18 10h3M18 14h3" />
        </symbol>
        <symbol id="grain-extenddown" viewBox="0 0 24 24">
          <path d="M3 3h11v8H3zM8 14v8m-3-3 3 3 3-3M18 10h3M18 14h3M18 18h3" />
        </symbol>
        <symbol id="grain-left" viewBox="0 0 24 24">
          <path d="M20 12H4m6-6-6 6 6 6" />
        </symbol>
        <symbol id="grain-right" viewBox="0 0 24 24">
          <path d="M4 12h16m-6-6 6 6-6 6" />
        </symbol>
        <symbol id="grain-up" viewBox="0 0 24 24">
          <path d="M12 20V4m-6 6 6-6 6 6" />
        </symbol>
        <symbol id="grain-down" viewBox="0 0 24 24">
          <path d="M12 4v16m-6-6 6 6 6-6" />
        </symbol>
      </svg>
      <div class="strip" role="toolbar" aria-label="Mobile editing actions">
        ${actions.map(
          (action) => html`
            <button
              type="button"
              aria-label=${action.label}
              title=${action.label}
              ?disabled=${this.disabled}
              @pointerdown=${this.preserveEditorFocus}
              @focus=${this.onButtonFocus}
              @blur=${this.onButtonBlur}
              @click=${() => this.activate(action.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${action.icon}"></use></svg>
            </button>
            ${action.separator ? html`<span class="separator" role="separator"></span>` : ''}
          `,
        )}
      </div>
    `;
  }

  private preserveEditorFocus = (event: PointerEvent) => {
    if (event.button === 0) event.preventDefault();
  };

  private activate(action: MobileToolbarAction) {
    if (this.disabled) return;
    this.dispatchEvent(
      new CustomEvent('mobile-toolbar-action', {
        detail: { action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onButtonFocus = () => this.reportFocusChange(true);
  private onButtonBlur = () => this.reportFocusChange(false);

  private reportFocusChange(focused: boolean) {
    this.dispatchEvent(
      new CustomEvent('mobile-toolbar-focus-change', {
        detail: { focused },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'md-mobile-keyboard-toolbar': MobileKeyboardToolbar;
  }
}
