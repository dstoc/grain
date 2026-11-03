import type { InlineInput } from '../../markdown/inline-render.js';

export type InlineInputIntent =
  | { readonly type: 'replace-blocks'; readonly text: string }
  | { readonly type: 'delete-blocks' }
  | {
      readonly type: 'command';
      readonly command: 'insert-paragraph' | 'insert-line-break' | 'delete-backward-at-start';
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: 'text';
      readonly from: number;
      readonly to: number;
      readonly insert: string;
      readonly isolated: boolean;
    }
  | { readonly type: 'delete-word-backward'; readonly from: number; readonly to: number }
  | { readonly type: 'ignored' };

export type InlineKeyIntent =
  | { readonly type: 'history'; readonly direction: 'undo' | 'redo' }
  | { readonly type: 'move-caret' }
  | { readonly type: 'delete-block-selection' }
  | { readonly type: 'indent'; readonly direction: 'indent' | 'outdent' }
  | { readonly type: 'select-all' }
  | { readonly type: 'seal-typing' }
  | { readonly type: 'none' };

export function translateInlineInput(
  detail: InlineInput,
  hasBlockSelection: boolean,
): InlineInputIntent {
  const { inputEvent, inputStart, inputEnd } = detail;
  let from = inputStart.index;
  const to = inputEnd.index;
  if (
    hasBlockSelection &&
    ['insertText', 'insertReplacementText', 'insertFromPaste'].includes(inputEvent.inputType)
  ) {
    return {
      type: 'replace-blocks',
      text:
        inputEvent.inputType === 'insertReplacementText'
          ? (inputEvent.dataTransfer?.getData('text/plain') ?? inputEvent.data ?? '')
          : (inputEvent.data ?? ''),
    };
  }
  if (
    hasBlockSelection &&
    ['deleteContentBackward', 'deleteContentForward', 'deleteByCut'].includes(inputEvent.inputType)
  ) {
    return { type: 'delete-blocks' };
  }
  if (inputEvent.inputType === 'insertParagraph') {
    if (detail.node.type === 'code-block') {
      return { type: 'text', from, to, insert: '\n', isolated: true };
    }
    return {
      type: 'command',
      command: 'insert-paragraph',
      from,
      to,
    };
  }
  if (inputEvent.inputType === 'insertLineBreak') {
    return { type: 'command', command: 'insert-line-break', from, to };
  }

  let insert: string;
  switch (inputEvent.inputType) {
    case 'insertText':
      insert = inputEvent.data ?? '';
      break;
    case 'insertReplacementText':
    case 'insertFromPaste':
      insert = inputEvent.dataTransfer?.getData('text/plain') ?? inputEvent.data ?? '';
      if (detail.node.type !== 'code-block') insert = insert.replace(/\n/g, ' ');
      break;
    case 'deleteByCut':
      insert = '';
      break;
    case 'deleteContentBackward':
      insert = '';
      if (from === to) from = previousCodePoint(detail.content, from);
      break;
    case 'deleteWordBackward':
      return { type: 'delete-word-backward', from, to };
    default:
      return { type: 'ignored' };
  }

  if (from === 0 && to === 0 && insert === '' && inputEvent.inputType.startsWith('delete')) {
    return { type: 'command', command: 'delete-backward-at-start', from, to };
  }
  return { type: 'text', from, to, insert, isolated: inputEvent.inputType !== 'insertText' };
}

export function translateInlineKey(
  event: KeyboardEvent,
  hasBlockSelection: boolean,
): InlineKeyIntent {
  const key = event.key;
  const control = event.ctrlKey || event.metaKey;
  if (control && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) {
    return { type: 'history', direction: key.toLowerCase() === 'z' ? 'undo' : 'redo' };
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
    return { type: 'move-caret' };
  }
  if ((key === 'Backspace' || key === 'Delete') && hasBlockSelection) {
    return { type: 'delete-block-selection' };
  }
  if (key === 'Tab') return { type: 'indent', direction: event.shiftKey ? 'outdent' : 'indent' };
  if (control && key.toLowerCase() === 'a') return { type: 'select-all' };
  if (key === 'Enter' || key.length !== 1 || control || event.altKey) {
    return { type: 'seal-typing' };
  }
  return { type: 'none' };
}

function previousCodePoint(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = text.charCodeAt(offset - 1);
  if (previous >= 0xdc00 && previous <= 0xdfff && offset >= 2) {
    const high = text.charCodeAt(offset - 2);
    if (high >= 0xd800 && high <= 0xdbff) return offset - 2;
  }
  return offset - 1;
}
