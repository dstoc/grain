import { viewModel } from './src/markdown/view-model-node.js';
import { serializeToString } from './src/markdown/block-serializer.js';

const baseCommit = '855fb4f2d671ce284b32dc7a70b678eade340aa9';
const panel = document.querySelector('#diagnostic');
const status = panel.querySelector('[role=status]');
const output = panel.querySelector('textarea');
const types = ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown', 'keyup'];
let entries = [];
let recording = false;
let sequence = 0;
const metadata = () => ({ baseCommit, diagnosticBuild: 'grain-35-android-preview-v1', url: location.href, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, userAgentData: navigator.userAgentData?.toJSON?.() ?? null });
let session;
function allInlines(root) {
  const found = [];
  function visit(node) {
    if (node instanceof Element && node.matches('md-inline')) found.push(node.textContent);
    if (node.shadowRoot) visit(node.shadowRoot);
    for (const child of node.children ?? []) visit(child);
  }
  visit(root);
  return found;
}
function snapshot() {
  const app = document.querySelector('md-dev-harness');
  const selection = document.getSelection();
  let model = null, serialized = null;
  try { model = app.root?.[viewModel].tree.serialize() ?? null; if (model) serialized = serializeToString(model); } catch (error) { model = { error: String(error) }; }
  return { renderInlines: allInlines(app), source: app.shadowRoot?.querySelector('#source')?.value ?? null, model, serialized, activeTab: app.activeTab, selection: selection && { text: selection.toString(), anchorNode: selection.anchorNode?.nodeName, anchorText: selection.anchorNode?.textContent, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode?.nodeName, focusText: selection.focusNode?.textContent, focusOffset: selection.focusOffset } };
}
function add(entry) { entries.push({ order: ++sequence, time: performance.now(), ...entry }); }
function handler(event) {
  if (!recording) return;
  const target = event.composedPath().find(node => node instanceof Element && node.matches('md-inline'));
  if (!target) return;
  const id = sequence + 1;
  const details = { id, type: event.type, eventTime: event.timeStamp, data: event.data ?? null, inputType: event.inputType ?? null, key: event.key ?? null, isComposing: event.isComposing ?? null, cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, isTrusted: event.isTrusted };
  add({ phase: 'capture', ...details, snapshot: snapshot() });
  queueMicrotask(() => { if (recording) add({ id, phase: 'microtask', defaultPrevented: event.defaultPrevented, snapshot: snapshot() }); });
  setTimeout(() => { if (recording) add({ id, phase: 'next-task', defaultPrevented: event.defaultPrevented, snapshot: snapshot() }); }, 0);
}
for (const type of types) document.addEventListener(type, handler, true);
document.addEventListener('click', event => {
  if (!recording || !event.composedPath().some(node => node instanceof Element && node.matches('.tab'))) return;
  add({ phase: 'tab-click', snapshot: snapshot() });
  setTimeout(() => { if (recording) add({ phase: 'tab-settled', snapshot: snapshot() }); }, 0);
}, true);
panel.querySelector('#start').onclick = () => { if (!recording) { session = metadata(); recording = true; add({ phase: 'start', snapshot: snapshot() }); status.textContent = 'Recording'; } };
panel.querySelector('#stop').onclick = () => { if (recording) { add({ phase: 'stop', snapshot: snapshot() }); recording = false; status.textContent = 'Stopped'; } };
panel.querySelector('#clear').onclick = () => { entries = []; sequence = 0; session = recording ? metadata() : null; output.value = ''; status.textContent = recording ? 'Recording; trace cleared' : 'Trace cleared'; };
panel.querySelector('#copy').onclick = async () => {
  const trace = JSON.stringify({ metadata: session, entries }, null, 2);
  try { await navigator.clipboard.writeText(trace); status.textContent = 'Trace copied'; }
  catch { output.value = trace; output.hidden = false; status.textContent = 'Copy unavailable: select and copy the trace below'; }
};
