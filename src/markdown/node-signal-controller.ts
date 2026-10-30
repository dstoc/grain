import { effect } from '@preact/signals-core';
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { viewModel, type ViewModelNode } from './view-model-node.js';

/** Observe only the current node while its host is connected. */
export class NodeSignalController implements ReactiveController {
  private node: ViewModelNode | undefined;
  private dispose: (() => void) | undefined;
  private connected = false;

  constructor(
    private host: ReactiveControllerHost,
    private currentNode: () => ViewModelNode | undefined,
  ) {
    host.addController(this);
  }

  hostConnected() {
    this.connected = true;
    this.subscribe();
    this.host.requestUpdate();
  }

  hostDisconnected() {
    this.connected = false;
    this.dispose?.();
    this.dispose = undefined;
    this.node = undefined;
  }

  hostUpdate() {
    if (this.connected && this.node !== this.currentNode()) this.subscribe();
  }

  private subscribe() {
    this.dispose?.();
    this.dispose = undefined;
    this.node = this.currentNode();
    if (!this.node) return;
    const node = this.node;
    let initial = true;
    this.dispose = effect(() => {
      node[viewModel].renderSignal.value;
      if (initial) initial = false;
      else if (this.currentNode() === node) this.host.requestUpdate();
    });
  }
}
