import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { MobileKeyboardToolbar, MobileToolbarAction } from './mobile-keyboard-toolbar.js';
import './mobile-keyboard-toolbar.js';

type Point = { x: number; y: number; time: number; id?: number; primary?: boolean };
type GestureSnapshot = {
  speed: number;
  residualX: number;
  residualY: number;
  axis?: 'horizontal' | 'vertical';
};

const slowStep = 20.4;

afterEach(async () => {
  await page.viewport(1280, 720);
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function mountToolbar() {
  const toolbar = document.createElement('md-mobile-keyboard-toolbar');
  toolbar.visible = true;
  toolbar.disabled = false;
  document.body.append(toolbar);
  await toolbar.updateComplete;
  const directional = toolbar.shadowRoot!.querySelector<HTMLButtonElement>('.directional')!;
  const actions: MobileToolbarAction[] = [];
  toolbar.addEventListener('mobile-toolbar-action', (event) => {
    actions.push((event as CustomEvent<{ action: MobileToolbarAction }>).detail.action);
  });
  return { toolbar, directional, actions };
}

function pointer(target: Element, type: string, point: Point) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: point.id ?? 1,
    isPrimary: point.primary ?? true,
    button: type === 'pointermove' ? -1 : 0,
    clientX: point.x,
    clientY: point.y,
  });
  Object.defineProperty(event, 'timeStamp', { configurable: true, value: point.time });
  target.dispatchEvent(event);
  return event;
}

async function settleDirectionalActions(pendingSteps = 1) {
  for (let step = 0; step < pendingSteps; step++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function state(toolbar: MobileKeyboardToolbar) {
  return (toolbar as unknown as { gesture?: GestureSnapshot }).gesture;
}

function gainAt(speed: number) {
  const ramp = Math.max(0, Math.min(1, (speed - 150) / 200));
  return 1 + ramp * (20.4 / 13.2 - 1);
}

test('one primary pointer emits no action until movement and ignores competing pointers', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  directional.dispatchEvent(click);
  expect(actions).toEqual([]);

  pointer(directional, 'pointerdown', { x: 10, y: 10, time: 0 });
  pointer(directional, 'pointerdown', { x: 10, y: 10, time: 1, id: 2, primary: false });
  pointer(directional, 'pointermove', { x: 100, y: 10, time: 20, id: 2, primary: false });
  expect(actions).toEqual([]);

  pointer(directional, 'pointerup', { x: 10, y: 10, time: 21 });
  expect(actions).toEqual([]);
  toolbar.remove();
});

test.each([
  [150, 1],
  [250, 14 / 11],
  [350, 17 / 11],
])('uses the linear gain curve at %i CSS px/s', async (speed, expectedGain) => {
  const { toolbar, directional, actions } = await mountToolbar();
  const alpha = 1 - Math.exp(-1);
  const dx = (speed * 60) / (1000 * alpha);
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  pointer(directional, 'pointermove', { x: dx, y: 0, time: 60 });
  await settleDirectionalActions(2);

  const gesture = state(toolbar)!;
  const emitted = actions.filter((action) => action === 'right').length;
  expect(gesture.speed).toBeCloseTo(speed, 8);
  expect(((emitted + gesture.residualX) * slowStep) / dx).toBeCloseTo(expectedGain, 8);
  expect(actions.every((action) => action === 'right')).toBe(true);
  toolbar.remove();
});

test('weights gradual speed changes by segment and keeps pre-lock movement at its original gain', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });

  let speed = 0;
  let weightedUnits = 0;
  let x = 0;
  let time = 0;
  for (const [dx, elapsed] of [
    [4, 40],
    [8, 40],
    [10, 40],
  ]) {
    const alpha = 1 - Math.exp(-elapsed / 60);
    speed += alpha * ((dx * 1000) / elapsed - speed);
    weightedUnits += (dx * gainAt(speed)) / slowStep;
    x += dx;
    time += elapsed;
    pointer(directional, 'pointermove', { x, y: 0, time });
    if (x < slowStep) expect(actions).toEqual([]);
  }

  const gesture = state(toolbar)!;
  const emitted = actions.filter((action) => action === 'right').length;
  expect(gesture.axis).toBe('horizontal');
  expect(gesture.speed).toBeCloseTo(speed, 8);
  expect(emitted).toBe(1);
  expect(emitted + gesture.residualX).toBeCloseTo(weightedUnits, 8);
  expect(gesture.residualX).toBeLessThan(0.2);
  toolbar.remove();
});

test('a slow start keeps its weighting when a fast segment crosses the lock threshold', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  pointer(directional, 'pointermove', { x: 10, y: 0, time: 100 });
  expect(actions).toEqual([]);
  pointer(directional, 'pointermove', { x: 21, y: 0, time: 110 });

  const gesture = state(toolbar)!;
  expect(gesture.axis).toBe('horizontal');
  expect(actions).toEqual(['right']);
  expect(gesture.residualX).toBeGreaterThan(0.1);
  expect(gesture.residualX).toBeLessThan(0.2);
  toolbar.remove();
});

test.each([30, 60, 120])('integrates a fast 224 px swipe consistently at %i Hz', async (hz) => {
  const { toolbar, directional, actions } = await mountToolbar();
  const speed = 1000;
  const distance = 224;
  const duration = (distance / speed) * 1000;
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  for (let time = 1000 / hz; time < duration - 1e-6; time += 1000 / hz) {
    pointer(directional, 'pointermove', { x: (speed * time) / 1000, y: 0, time });
  }
  pointer(directional, 'pointermove', { x: distance, y: 0, time: duration });
  await settleDirectionalActions(15);
  expect(actions).toHaveLength(16);
  expect(actions.every((action) => action === 'right')).toBe(true);
  pointer(directional, 'pointerup', { x: distance, y: 0, time: duration + 1 });
  toolbar.remove();
});

test('slow and fast swipes of the same distance emit the expected step counts', async () => {
  for (const [speed, expected] of [
    [100, 10],
    [1000, 16],
  ]) {
    const { toolbar, directional, actions } = await mountToolbar();
    const distance = 224;
    const duration = (distance / speed) * 1000;
    pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
    for (let time = 1000 / 60; time < duration - 1e-6; time += 1000 / 60) {
      pointer(directional, 'pointermove', { x: (speed * time) / 1000, y: 0, time });
    }
    pointer(directional, 'pointermove', { x: distance, y: 0, time: duration });
    await settleDirectionalActions(expected - 1);
    expect(actions).toHaveLength(expected);
    expect(actions.every((action) => action === 'right')).toBe(true);
    toolbar.remove();
  }
});

test('locks the first stepped axis, discards cross-axis drift, and allows reversal', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  pointer(directional, 'pointermove', { x: 10, y: 10, time: 100 });
  expect(actions).toEqual([]);
  pointer(directional, 'pointermove', { x: 21, y: 20, time: 200 });
  expect(actions).toEqual(['right']);
  pointer(directional, 'pointermove', { x: 21, y: 100, time: 300 });
  expect(actions).toEqual(['right']);
  pointer(directional, 'pointermove', { x: 1, y: 100, time: 500 });
  expect(actions).toEqual(['right']);
  pointer(directional, 'pointermove', { x: -19, y: 100, time: 700 });
  await settleDirectionalActions(1);
  expect(actions).toEqual(['right', 'left']);
  pointer(directional, 'pointerup', { x: -19, y: 100, time: 701 });
  toolbar.remove();
});

test('uses horizontal lock for an exact diagonal tie', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  pointer(directional, 'pointermove', { x: 21, y: 21, time: 100 });
  await settleDirectionalActions();
  expect(state(toolbar)!.axis).toBe('horizontal');
  expect(actions.length).toBeGreaterThan(0);
  expect(actions.every((action) => action === 'right')).toBe(true);
  toolbar.remove();
});

test('resets speed after a pause, emits no phantom steps at rest, and handles a large delta', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  pointer(directional, 'pointermove', { x: 21, y: 0, time: 210 });
  expect(actions).toEqual(['right']);
  pointer(directional, 'pointermove', { x: 21, y: 0, time: 500 });
  pointer(directional, 'pointermove', { x: 21, y: 0, time: 700 });
  expect(actions).toEqual(['right']);
  pointer(directional, 'pointermove', { x: 23, y: 0, time: 800 });
  expect(actions).toEqual(['right']);

  pointer(directional, 'pointerup', { x: 23, y: 0, time: 801 });
  const actionsBeforeLargeDelta = actions.length;
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 1000, id: 2 });
  pointer(directional, 'pointermove', { x: 1000, y: 0, time: 2000, id: 2 });
  await settleDirectionalActions(74);
  expect(actions.length - actionsBeforeLargeDelta).toBe(75);
  expect(actions.every((action) => action === 'right')).toBe(true);
  toolbar.remove();
});

test.each([
  'pointerup',
  'pointercancel',
  'lostpointercapture',
  'disabled',
  'hidden',
  'disconnected',
] as const)('cancels and resets an active gesture on %s', async (ending) => {
  const { toolbar, directional, actions } = await mountToolbar();
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  pointer(directional, 'pointermove', { x: 21, y: 0, time: 210 });
  expect(actions).toEqual(['right']);

  if (ending === 'pointerup' || ending === 'pointercancel' || ending === 'lostpointercapture') {
    pointer(directional, ending, { x: 21, y: 0, time: 220 });
  } else if (ending === 'disabled') {
    toolbar.disabled = true;
    await toolbar.updateComplete;
  } else if (ending === 'hidden') {
    toolbar.hidden = true;
  } else {
    toolbar.remove();
  }

  pointer(directional, 'pointermove', { x: 100, y: 0, time: 300 });
  expect(actions).toEqual(['right']);
  if (ending === 'hidden') toolbar.hidden = false;
  if (ending === 'disabled') toolbar.disabled = false;
  if (ending === 'disconnected') document.body.append(toolbar);
  await toolbar.updateComplete;
  const nextId = 2;
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 400, id: nextId });
  pointer(directional, 'pointermove', { x: 21, y: 0, time: 610, id: nextId });
  expect(actions).toEqual(['right', 'right']);
  toolbar.remove();
});

test('drops undispatched directional steps after the toolbar becomes unavailable', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
  pointer(directional, 'pointermove', { x: 61.5, y: 0, time: 615 });
  expect(actions).toEqual(['right']);

  toolbar.disabled = true;
  await toolbar.updateComplete;
  await settleDirectionalActions(2);
  expect(actions).toEqual(['right']);

  toolbar.disabled = false;
  await toolbar.updateComplete;
  pointer(directional, 'pointerdown', { x: 0, y: 0, time: 1000, id: 2 });
  pointer(directional, 'pointermove', { x: 21, y: 0, time: 1210, id: 2 });
  expect(actions).toEqual(['right', 'right']);
  toolbar.remove();
});

test('keyboard arrows emit one action and prevent page navigation', async () => {
  const { toolbar, directional, actions } = await mountToolbar();
  directional.focus();
  for (const [key, action] of [
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
  ] as const) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    directional.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(actions.at(-1)).toBe(action);
  }
  expect(actions).toEqual(['left', 'right', 'up', 'down']);
  toolbar.remove();
});

test('requests 1 ms vibration per step and button action without blocking on failures', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
  const setVibration = (value: unknown) =>
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      writable: true,
      value,
    });
  try {
    const requests: number[] = [];
    setVibration((duration: number) => {
      requests.push(duration);
      return true;
    });
    const { toolbar, directional, actions } = await mountToolbar();
    toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Unindent"]')!.click();
    pointer(directional, 'pointerdown', { x: 0, y: 0, time: 0 });
    pointer(directional, 'pointermove', { x: 41, y: 0, time: 410 });
    await settleDirectionalActions(1);
    expect(actions).toEqual(['unindent', 'right', 'right']);
    expect(requests).toEqual([1, 1, 1]);

    setVibration(() => false);
    toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Indent"]')!.click();
    setVibration(() => {
      throw new Error('unsupported');
    });
    const split = toolbar.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')[2]!;
    split.click();
    setVibration(undefined);
    toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Unindent"]')!.click();
    setVibration(() => Promise.reject(new Error('rejected')));
    toolbar
      .shadowRoot!.querySelector<HTMLButtonElement>(
        'button[aria-label="Extend block selection upward"]',
      )!
      .click();
    await Promise.resolve();
    expect(actions.slice(-4)).toEqual(['indent', 'split', 'unindent', 'extend-up']);
    expect(requests).toEqual([1, 1, 1]);
    toolbar.remove();
  } finally {
    if (original) Object.defineProperty(navigator, 'vibrate', original);
    else Reflect.deleteProperty(navigator, 'vibrate');
  }
});
