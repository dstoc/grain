import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type MobileToolbarAction =
  | 'unindent'
  | 'indent'
  | 'split'
  | 'select-all'
  | 'extend-up'
  | 'extend-down'
  | 'undo'
  | 'redo'
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
  { id: 'undo', label: 'Undo', icon: 'grain-undo' },
  { id: 'redo', label: 'Redo', icon: 'grain-redo', separator: true },
];

type Gesture = {
  id: number;
  pointerId: number;
  button: HTMLButtonElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  time: number;
  speed: number;
  residualX: number;
  residualY: number;
  axis?: 'horizontal' | 'vertical';
};

type QueuedDirectionalAction = {
  action: MobileToolbarAction;
  gestureId: number;
};

const arrowActions = {
  left: 'left',
  right: 'right',
  up: 'up',
  down: 'down',
} as const;

const lowSpeed = 150;
const highSpeed = 350;
const slowStep = 20.4;
const fastStep = 10.2;

function speedGain(speed: number) {
  const ramp = Math.max(0, Math.min(1, (speed - lowSpeed) / (highSpeed - lowSpeed)));
  return 1 + ramp * (slowStep / fastStep - 1);
}

function pointerTime(event: PointerEvent) {
  return Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
}

function vibrate() {
  try {
    const requestVibration = navigator.vibrate as unknown as (durationMs: number) => boolean;
    if (typeof requestVibration !== 'function') return;
    const result = requestVibration.call(navigator, 1) as unknown;
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Haptics are best effort and must not block the toolbar action.
  }
}

@customElement('md-mobile-keyboard-toolbar')
export class MobileKeyboardToolbar extends LitElement {
  static override get observedAttributes() {
    return [...super.observedAttributes, 'hidden'];
  }

  static override styles = css`
    :host {
      position: fixed;
      top: var(--toolbar-top, 0px);
      z-index: 1001;
      right: 0;
      left: 0;
      display: block;
      box-sizing: border-box;
      max-width: 100vw;
      color: var(--root-color, #334432);
      font:
        16px/1.2 system-ui,
        sans-serif;
      -webkit-tap-highlight-color: transparent;
    }

    :host(:not([visible])),
    :host([hidden]) {
      display: none;
    }

    .strip {
      display: flex;
      width: min(100%, 560px);
      min-height: 56px;
      box-sizing: border-box;
      margin: 0 auto;
      padding: 3px 6px;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
      touch-action: pan-x;
      background: color-mix(
        in srgb,
        var(--root-background-color, #fbfcf9) 96%,
        var(--root-color, #334432)
      );
      border-top: 1px solid color-mix(in srgb, var(--root-color, #334432) 18%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--root-color, #334432) 18%, transparent);
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
      background: color-mix(in srgb, var(--md-active-block-color, #e9eee5) 78%, transparent);
    }

    button:focus-visible {
      outline: 2px solid var(--md-accent-color, #67f);
      outline-offset: -2px;
    }

    button:disabled {
      color: color-mix(
        in srgb,
        var(--root-color, #334432) 42%,
        var(--root-background-color, #fbfcf9)
      );
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

    .directional {
      touch-action: none;
    }

    .separator {
      flex: 0 0 1px;
      align-self: center;
      height: 28px;
      margin: 0 6px;
      background: color-mix(in srgb, var(--root-color, #334432) 18%, transparent);
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
  @property({ type: Boolean }) accessor undoDisabled = true;
  @property({ type: Boolean }) accessor redoDisabled = true;
  private gesture: Gesture | undefined;
  private nextGestureId = 0;
  private pendingDirectionalActions: QueuedDirectionalAction[] = [];
  private directionalActionDispatchScheduled = false;
  private directionalActionDispatchTimer: number | undefined;
  private directionalActionDispatchGeneration = 0;

  override attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ) {
    super.attributeChangedCallback(name, oldValue, newValue);
    if (name === 'hidden' && newValue !== null) this.cancelUnavailableInteraction();
  }

  protected override willUpdate() {
    if (this.disabled || !this.visible || this.hidden) this.cancelUnavailableInteraction();
  }

  override disconnectedCallback() {
    this.cancelUnavailableInteraction();
    super.disconnectedCallback();
  }

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
        <symbol id="grain-undo" viewBox="0 0 24 24">
          <path d="M9 5 4 10l5 5M4 10h9a6 6 0 0 1 6 6v3" />
        </symbol>
        <symbol id="grain-redo" viewBox="0 0 24 24">
          <path d="m15 5 5 5-5 5M20 10h-9a6 6 0 0 0-6 6v3" />
        </symbol>
      </svg>
      <div class="strip" role="toolbar" aria-label="Mobile editing actions">
        ${actions.slice(0, 3).map((action) => this.renderAction(action))}
        <button
          class="directional"
          type="button"
          aria-label="Move caret with directional drag"
          title="Move caret with directional drag"
          ?disabled=${this.disabled}
          @pointerdown=${this.startGesture}
          @pointermove=${this.moveGesture}
          @pointerup=${this.finishGesture}
          @pointercancel=${this.cancelGestureForPointer}
          @lostpointercapture=${this.cancelGestureForPointer}
          @keydown=${this.onDirectionalKeydown}
          @focus=${this.onButtonFocus}
          @blur=${this.onButtonBlur}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3" />
          </svg>
        </button>
        <span class="separator" role="separator"></span>
        ${actions.slice(3).map((action) => this.renderAction(action))}
      </div>
    `;
  }

  private renderAction(action: (typeof actions)[number]) {
    return html`
      <button
        type="button"
        aria-label=${action.label}
        title=${action.label}
        ?disabled=${this.disabled || this.isActionDisabled(action.id)}
        @pointerdown=${this.preserveEditorFocus}
        @focus=${this.onButtonFocus}
        @blur=${this.onButtonBlur}
        @click=${() => this.activate(action.id)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${action.icon}"></use></svg>
      </button>
      ${action.separator ? html`<span class="separator" role="separator"></span>` : ''}
    `;
  }

  private preserveEditorFocus = (event: PointerEvent) => {
    if (event.button === 0) event.preventDefault();
  };

  private startGesture = (event: PointerEvent) => {
    if (event.button === 0) event.preventDefault();
    if (
      this.gesture ||
      !event.isPrimary ||
      event.button !== 0 ||
      this.disabled ||
      !this.visible ||
      this.hidden ||
      !this.isConnected
    ) {
      return;
    }
    const button = event.currentTarget as HTMLButtonElement;
    const time = pointerTime(event);
    this.gesture = {
      id: ++this.nextGestureId,
      pointerId: event.pointerId,
      button,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      time,
      speed: 0,
      residualX: 0,
      residualY: 0,
    };
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and detached test targets cannot capture a pointer.
    }
  };

  private moveGesture = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (!this.isGestureAvailable()) {
      this.cancelUnavailableInteraction();
      return;
    }

    const time = pointerTime(event);
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const elapsed = Math.max(1, time - gesture.time);
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    gesture.time = time;
    if (dx === 0 && dy === 0) {
      if (elapsed > 120) gesture.speed = 0;
      return;
    }
    if (elapsed > 120) gesture.speed = 0;

    const wasLocked = gesture.axis;
    const speedDistance =
      wasLocked === 'horizontal'
        ? Math.abs(dx)
        : wasLocked === 'vertical'
          ? Math.abs(dy)
          : Math.hypot(dx, dy);
    const instantaneousSpeed = (speedDistance * 1000) / elapsed;
    const alpha = 1 - Math.exp(-elapsed / 60);
    gesture.speed += alpha * (instantaneousSpeed - gesture.speed);
    const scale = speedGain(gesture.speed) / slowStep;

    if (!wasLocked || wasLocked === 'horizontal') gesture.residualX += dx * scale;
    if (!wasLocked || wasLocked === 'vertical') gesture.residualY += dy * scale;

    if (!gesture.axis) {
      const totalX = event.clientX - gesture.startX;
      const totalY = event.clientY - gesture.startY;
      if (Math.max(Math.abs(totalX), Math.abs(totalY)) >= slowStep) {
        gesture.axis = Math.abs(totalX) >= Math.abs(totalY) ? 'horizontal' : 'vertical';
        if (gesture.axis === 'horizontal') gesture.residualY = 0;
        else gesture.residualX = 0;
      }
    }
    if (gesture.axis === 'horizontal') this.emitResidual(gesture, 'horizontal');
    else if (gesture.axis === 'vertical') this.emitResidual(gesture, 'vertical');
  };

  private finishGesture = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (gesture?.pointerId === event.pointerId) this.clearGesture(gesture);
  };

  private cancelGestureForPointer = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (gesture?.pointerId === event.pointerId) this.cancelGesture();
  };

  private cancelGesture() {
    const gesture = this.gesture;
    if (!gesture) return;
    this.pendingDirectionalActions = this.pendingDirectionalActions.filter(
      (queued) => queued.gestureId !== gesture.id,
    );
    this.clearGesture(gesture);
    if (this.pendingDirectionalActions.length === 0) this.cancelDirectionalActionDispatch();
  }

  private clearGesture(gesture: Gesture) {
    this.gesture = undefined;
    try {
      if (gesture.button.hasPointerCapture(gesture.pointerId))
        gesture.button.releasePointerCapture(gesture.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }

  private cancelUnavailableInteraction() {
    this.cancelGesture();
    this.pendingDirectionalActions = [];
    this.cancelDirectionalActionDispatch();
  }

  private cancelDirectionalActionDispatch() {
    this.directionalActionDispatchGeneration++;
    if (this.directionalActionDispatchTimer !== undefined) {
      window.clearTimeout(this.directionalActionDispatchTimer);
    }
    this.directionalActionDispatchTimer = undefined;
    this.directionalActionDispatchScheduled = false;
  }

  private isGestureAvailable() {
    return (
      this.isConnected &&
      this.visible &&
      !this.disabled &&
      !this.hidden &&
      this.getClientRects().length > 0
    );
  }

  private emitResidual(gesture: Gesture, axis: 'horizontal' | 'vertical') {
    const horizontal = axis === 'horizontal';
    let residual = horizontal ? gesture.residualX : gesture.residualY;
    const actions: MobileToolbarAction[] = [];
    while (residual >= 1) {
      actions.push(horizontal ? arrowActions.right : arrowActions.down);
      residual -= 1;
    }
    while (residual <= -1) {
      actions.push(horizontal ? arrowActions.left : arrowActions.up);
      residual += 1;
    }
    if (horizontal) gesture.residualX = residual;
    else gesture.residualY = residual;
    this.enqueueDirectionalActions(actions, gesture.id);
  }

  private enqueueDirectionalActions(actions: MobileToolbarAction[], gestureId: number) {
    this.pendingDirectionalActions.push(...actions.map((action) => ({ action, gestureId })));
    if (this.directionalActionDispatchScheduled) return;
    this.dispatchNextDirectionalAction();
  }

  private dispatchNextDirectionalAction() {
    if (!this.isGestureAvailable()) {
      this.cancelUnavailableInteraction();
      return;
    }
    const queued = this.pendingDirectionalActions.shift();
    if (queued === undefined) return;
    this.activate(queued.action);
    if (this.pendingDirectionalActions.length === 0) return;

    // Let a cross-block focus update render before routing the next step.
    this.directionalActionDispatchScheduled = true;
    const generation = this.directionalActionDispatchGeneration;
    this.directionalActionDispatchTimer = window.setTimeout(() => {
      if (generation !== this.directionalActionDispatchGeneration) return;
      this.directionalActionDispatchTimer = undefined;
      this.directionalActionDispatchScheduled = false;
      this.dispatchNextDirectionalAction();
    }, 0);
  }

  private onDirectionalKeydown = (event: KeyboardEvent) => {
    const action =
      event.key === 'ArrowLeft'
        ? 'left'
        : event.key === 'ArrowRight'
          ? 'right'
          : event.key === 'ArrowUp'
            ? 'up'
            : event.key === 'ArrowDown'
              ? 'down'
              : undefined;
    if (!action || this.disabled) return;
    event.preventDefault();
    this.activate(action);
  };

  private activate(action: MobileToolbarAction) {
    if (this.disabled || this.isActionDisabled(action)) return;
    vibrate();
    this.dispatchEvent(
      new CustomEvent('mobile-toolbar-action', {
        detail: { action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private isActionDisabled(action: MobileToolbarAction) {
    return (action === 'undo' && this.undoDisabled) || (action === 'redo' && this.redoDisabled);
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
