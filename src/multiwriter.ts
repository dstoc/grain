import {
  MobileKeyboardToolbar,
  type MobileToolbarActionEvent,
} from './editing/mobile-keyboard-toolbar.js';
import { MarkdownInline } from './markdown/inline-render.js';
import { MultiwriterEditor } from './editing/multiwriter-editor.js';
import { createGenesis, decodeGenesis } from './markdown/multiwriter/bootstrap/index.js';
import { IndexedDBActionJournal } from './markdown/multiwriter/providers/index.js';
import { openReplica, type Replica } from './markdown/multiwriter/replica/index.js';
import { ReplicaNetwork } from './markdown/multiwriter/replica/network.js';
import { serializeProjection } from './markdown/multiwriter/projection/index.js';
import type { ViewNode } from './markdown/multiwriter/projection/types.js';
import type { SyncMode } from './markdown/multiwriter/contracts.js';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const source = get<HTMLTextAreaElement>('source');
const modes: SyncMode[] = ['bidirectional', 'outbound-only', 'inbound-only', 'disconnected'];
const toolbar = new MobileKeyboardToolbar();
document.body.append(toolbar);
let toolbarTarget: MultiwriterEditor | undefined;
let toolbarWork = Promise.resolve();
let selectionRoot: ShadowRoot | undefined;
let caretFrame: number | undefined;
toolbar.addEventListener('mobile-toolbar-action', (event: MobileToolbarActionEvent) => {
  const target = toolbarTarget;
  toolbarWork = toolbarWork
    .then(async () => {
      if (target !== toolbarTarget || !target?.isConnected) return;
      await target.toolbarAction(event.detail.action);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      schedule();
    })
    .catch(report);
});
document.addEventListener('focusin', (event) => {
  const path = event.composedPath(),
    target = path.find((node) => node instanceof MultiwriterEditor);
  if (target instanceof MultiwriterEditor) {
    toolbarTarget = target;
    const inline = path.find((node) => node instanceof MarkdownInline);
    const root = inline instanceof MarkdownInline ? inline.getRootNode() : undefined;
    if (root instanceof ShadowRoot && root !== selectionRoot) {
      selectionRoot?.removeEventListener('selectionchange', schedule);
      selectionRoot = root;
      selectionRoot.addEventListener('selectionchange', schedule);
    }
  } else if (!path.includes(toolbar)) toolbarTarget = undefined;
  schedule();
});
window.visualViewport?.addEventListener('resize', schedule);
window.visualViewport?.addEventListener('scroll', schedule);
window.addEventListener('resize', schedule);
document.addEventListener('selectionchange', schedule);
const panes = new Map<
  string,
  {
    replica: Replica;
    editor: MultiwriterEditor;
    status: HTMLElement;
    mode: HTMLSelectElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    stop(): void;
  }
>();
let experiment: { id: string; genesis: Uint8Array };
let network = new ReplicaNetwork(report);
let working = false,
  renderPending = false;
function report(error: unknown) {
  get('errors').textContent = String(error);
}
function button(label: string, action: () => unknown): HTMLButtonElement {
  const result = document.createElement('button');
  result.textContent = label;
  result.addEventListener('click', () => {
    void Promise.resolve().then(action).catch(report);
  });
  return result;
}
async function metadata(value?: typeof experiment): Promise<typeof experiment | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('grain-mw14-host', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('experiments');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('experiments', value ? 'readwrite' : 'readonly');
      const store = tx.objectStore('experiments');
      const request = value ? store.put(value, 'active') : store.get('active');
      tx.oncomplete = () => resolve(value ?? request.result);
      tx.onabort = () => reject(tx.error ?? new Error('Experiment metadata transaction failed'));
    });
  } finally {
    db.close();
  }
}
async function openPane(id: string) {
  const descriptor = decodeGenesis(experiment.genesis);
  const stored = await metadata();
  const journal = await IndexedDBActionJournal.open({
    namespace: `mw14:${experiment.id}:${id}`,
    protocolVersion: 3,
    documentId: descriptor.documentId,
    genesisId: descriptor.genesisId,
  });
  const replica = await openReplica({
    genesis: experiment.genesis,
    persistedGenesis: stored?.genesis,
    journal,
    mode: 'bidirectional',
    onError: (failure) => {
      report(failure.error);
      schedule();
    },
  });
  const editor = new MultiwriterEditor();
  editor.replica = replica;
  editor.addEventListener('replica-edit-error', (event) => report((event as CustomEvent).detail));
  const section = document.createElement('section');
  section.dataset.pane = id;
  const heading = document.createElement('h2');
  heading.textContent = `Pane ${id} · account demo`;
  const controls = document.createElement('div');
  controls.className = 'controls';
  const label = document.createElement('label');
  label.textContent = `Sync ${id} `;
  const mode = document.createElement('select');
  mode.ariaLabel = `Pane ${id} sync mode`;
  for (const name of modes) {
    const option = document.createElement('option');
    option.value = option.textContent = name;
    mode.append(option);
  }
  mode.onchange = () => {
    try {
      replica.setMode(mode.value as SyncMode);
    } catch (error) {
      report(error);
    }
    schedule();
  };
  label.append(mode);
  const undo = button('Undo', () => editor.navigate('undo')),
    redo = button('Redo', () => editor.navigate('redo'));
  // Keep the initiating inline focused, as in keyboard history navigation.
  undo.addEventListener('pointerdown', (e) => e.preventDefault());
  redo.addEventListener('pointerdown', (e) => e.preventDefault());
  const restart = button('Restart', () => restartPane(id));
  const persist = button('Retry persistence', async () => {
    await replica.retryPersistence();
    schedule();
  });
  const retry = button('Resume publication', () => {
    replica.retryPublication(100_000);
    schedule();
  });
  controls.append(label, undo, redo, restart, persist, retry);
  const status = document.createElement('p');
  status.className = 'status';
  status.role = 'status';
  section.append(heading, controls, status, editor);
  const previous = get('panes').querySelector(`[data-pane="${id}"]`);
  if (previous) previous.replaceWith(section);
  else get('panes').append(section);
  const stop = replica.subscribe(() => {
    schedule();
    // Publication durability settles independently of application.
    void replica.flush().then(schedule).catch(report);
  });
  panes.set(id, { replica, editor, status, mode, undo, redo, stop });
  network.add(id, replica);
  void replica.flush().then(schedule).catch(report);
  schedule();
}
function connect() {
  network.connect('A', 'B');
  network.connect('B', 'A');
}
async function restartPane(id: string) {
  if (working) return;
  working = true;
  try {
    const pane = panes.get(id)!;
    const mode = pane.replica.status().mode;
    await pane.replica.close();
    pane.stop();
    pane.editor.remove();
    await openPane(id);
    panes.get(id)!.replica.setMode(mode);
    connect();
    get('errors').textContent =
      `Pane ${id} restarted from its own journal. Its navigation history reset.`;
  } finally {
    working = false;
    schedule();
  }
}
function schedule() {
  if (renderPending) return;
  renderPending = true;
  queueMicrotask(() => {
    renderPending = false;
    render();
  });
}
function render() {
  const state = toolbarTarget?.replica?.status();
  toolbar.visible = !!toolbarTarget?.isConnected;
  toolbar.disabled = !state?.canAuthor;
  toolbar.undoDisabled = !state?.history.canUndo;
  toolbar.redoDisabled = !state?.history.canRedo;
  const viewport = window.visualViewport;
  toolbar.style.setProperty(
    '--toolbar-top',
    `${(viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 56}px`,
  );
  for (const [id, pane] of panes) {
    const state = pane.replica.status();
    if (state.observerErrors.length) report(state.observerErrors.at(-1));
    pane.mode.value = state.mode;
    pane.mode.disabled = state.lifecycle !== 'open';
    pane.undo.disabled = !state.canAuthor || !state.history.canUndo;
    pane.redo.disabled = !state.canAuthor || !state.history.canRedo;
    const persistence =
      state.lifecycle === 'open' ? pane.replica.capturePersistence().status() : undefined;
    pane.status.textContent = `${id}: local publication ${state.version}; ${state.lifecycle}; ${state.canAuthor ? 'editable' : 'input paused'}; applied locally; ${persistence?.persisted ? 'persisted' : 'persistence pending'}; local edits ${state.localEdits}, controls ${state.localControls}; undo ${state.history.undo}, redo ${state.history.redo}${state.history.reset ? '; history reset on open' : ''}. ${state.mode === 'outbound-only' || state.mode === 'disconnected' ? 'Receiving is disabled. This view can intentionally differ.' : ''}`;
  }
  const queue = network.queue();
  get('queue-status').textContent =
    `${queue.length} queued messages. Handoff only; no peer receipt is claimed.`;
  const items = queue.map((message, index) => {
    const item = document.createElement('li');
    item.append(
      document.createTextNode(
        `${message.from} → ${message.to} · ${message.update.byteLength} bytes `,
      ),
      button('Deliver', () => {
        const result = network.deliver(message.id);
        if (result.state !== 'admitted') report(`Delivery ${result.state}`);
      }),
      button('Duplicate', () => network.duplicate(message.id)),
      button('Drop', () => network.drop(message.id)),
    );
    if (index) item.append(button('Move up', () => network.move(message.id, queue[index - 1].id)));
    return item;
  });
  get('queue').replaceChildren(...items);
  if (caretFrame !== undefined) cancelAnimationFrame(caretFrame);
  caretFrame = requestAnimationFrame(keepCaretVisible);
}
function keepCaretVisible() {
  caretFrame = undefined;
  const editor = toolbarTarget;
  if (!editor?.isConnected) return;
  let active = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement;
  if (!(active instanceof MarkdownInline) || !active.isConnected) return;
  try {
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0,
      bottom = top + (viewport?.height ?? innerHeight) - 56;
    const rect = editor.getBoundingClientRect(),
      y = active.getCaretPosition().y;
    const high = Math.max(top, rect.top) + 12,
      low = Math.min(bottom, rect.bottom) - 12;
    if (y > low) editor.scrollTop += y - low;
    else if (y < high) editor.scrollTop -= high - y;
    const current = active.getCaretPosition().y;
    if (current > bottom - 12) window.scrollBy(0, current - bottom + 28);
    else if (current < top + 12) window.scrollBy(0, current - top - 28);
  } catch {
    // Rendering can briefly have no measurable native caret.
  }
}
function exportPane() {
  const id = get<HTMLSelectElement>('export-pane').value,
    pane = panes.get(id)!;
  source.value = serializeProjection(pane.replica.publication().value.view);
  const label = `Captured from pane ${id}, local publication ${pane.replica.status().version}. Loading Source creates new replicas and history; it does not synchronize existing panes.`;
  get('source-label').textContent = label;
  get('tree-label').textContent = `Tree captured from pane ${id}`;
  const semantic = (node: ViewNode): unknown => ({
    type: node.type,
    ...(node.content ? { content: node.content } : {}),
    marker: node.marker,
    checked: node.checked,
    children: node.children.map(semantic),
  });
  get('tree').textContent = JSON.stringify(
    semantic(pane.replica.publication().value.view.root),
    null,
    2,
  );
}
async function newExperiment(markdown: string) {
  if (working) return;
  working = true;
  try {
    const next = { id: crypto.randomUUID(), genesis: createGenesis(crypto.randomUUID(), markdown) };
    for (const pane of panes.values()) await pane.replica.close();
    for (const pane of panes.values()) {
      pane.stop();
      pane.editor.remove();
    }
    network.dispose();
    panes.clear();
    get('panes').replaceChildren();
    // Exact metadata is durable before either independent journal attaches.
    await metadata(next);
    experiment = next;
    network = new ReplicaNetwork(report);
    network.subscribe(schedule);
    network.setAutomatic(get<HTMLInputElement>('automatic').checked);
    await openPane('A');
    await openPane('B');
    connect();
    exportPane();
    get('errors').textContent = '';
  } finally {
    working = false;
    schedule();
  }
}
get('retry-a').onclick = () => {
  void network.retry('A').catch(report);
};
get('retry-b').onclick = () => {
  void network.retry('B').catch(report);
};
get('deliver-all').onclick = () => {
  for (const message of network.queue()) {
    try {
      network.deliver(message.id);
    } catch (error) {
      report(error);
    }
  }
};
get<HTMLInputElement>('automatic').onchange = (event) =>
  network.setAutomatic((event.target as HTMLInputElement).checked);
get('export').onclick = exportPane;
get('new').onclick = () => {
  void newExperiment(source.value).catch(report);
};
async function start() {
  const saved = await metadata();
  if (!saved) {
    await newExperiment(
      '# Independent panes\n\nEdit either pane, then deliver its messages.\n\n* [ ] Try a task',
    );
    return;
  }
  experiment = saved;
  network.subscribe(schedule);
  await openPane('A');
  await openPane('B');
  connect();
  exportPane();
}
void start().catch(report);
