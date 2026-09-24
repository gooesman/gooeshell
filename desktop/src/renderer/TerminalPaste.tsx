import { useEffect, useId, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import './terminal-paste.css';

export function pasteLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // A final newline ends the previous line; it is not another command.
  if (lines.at(-1) === '') lines.pop();
  return lines.length ? lines : [''];
}
export type PasteState = { text: string; lines: string[]; mode: 'choose' | 'lines'; index: number; submitted: boolean } | null;
export class TerminalPasteController {
  state: PasteState = null;
  constructor(private paste: (text: string) => void, private change: (state: PasteState) => void) {}
  private set(state: PasteState) { this.state = state; this.change(state); }
  offer(text: string) {
    if (!text) return;
    if (/[\r\n]/.test(text)) this.set({ text, lines: pasteLines(text), mode: 'choose', index: 0, submitted: false });
    else { this.cancel(); this.paste(text); }
  }
  edit(text: string) {
    const state = this.state; if (state?.mode !== 'choose') return;
    this.set({ ...state, text, lines: pasteLines(text), index: 0, submitted: false });
  }
  choose(mode: 'all' | 'lines') {
    const state = this.state; if (state?.mode !== 'choose' || !state.text) return;
    if (mode === 'all') { this.set(null); this.paste(state.text); }
    else { this.set({ ...state, mode: 'lines' }); this.paste(state.lines[0]); }
  }
  input(data: string) {
    const state = this.state;
    if (state?.mode !== 'lines') return;
    if (data.includes('\x03')) { this.cancel(); return; }
    if (data === '\r' || data === '\n') {
      if (state.index === state.lines.length - 1) this.cancel();
      else this.set({ ...state, submitted: true });
    }
  }
  next() {
    const state = this.state;
    if (state?.mode !== 'lines' || !state.submitted || state.index + 1 >= state.lines.length) return;
    const next = { ...state, index: state.index + 1, submitted: false };
    this.set(next); this.paste(next.lines[next.index]);
  }
  cancel() { this.set(null); }
}

export function TerminalPastePanel({ state, controller, terminal, connectionName }: {
  state: NonNullable<PasteState>; controller: TerminalPasteController; terminal: Terminal | null; connectionName: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const cancel = () => { controller.cancel(); terminal?.focus(); };
  useEffect(() => {
    if (state.mode !== 'choose') return;
    const dialog = element.current;
    dialog?.querySelector<HTMLButtonElement>('[data-paste-choice="all"]')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key === 'Tab') {
        const controls = [...dialog!.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)')];
        event.preventDefault(); event.stopPropagation();
        const i = controls.indexOf(document.activeElement as HTMLElement);
        controls[(i + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    };
    dialog?.addEventListener('keydown', keyboard);
    return () => dialog?.removeEventListener('keydown', keyboard);
  }, [state.mode]);
  if (state.mode === 'lines') return <div className="terminal-paste-queue" role="status" data-paste-line={state.index + 1}>
    <div><strong>逐行粘贴 · {state.index + 1} / {state.lines.length}</strong><span>{state.submitted ? '当前行已提交；终端准备好后，按 Ctrl+Enter 填入下一行。' : 'Enter 执行当前行，Ctrl+Enter 填入下一行。Ctrl+C 取消剩余行。'}</span></div>
    <button type="button" className="button small secondary" disabled={!state.submitted} aria-keyshortcuts="Control+Enter" onClick={() => { controller.next(); terminal?.focus(); }}>填入下一行<kbd>Ctrl+Enter</kbd></button>
    <button type="button" className="button small secondary" onClick={cancel}>取消剩余</button>
  </div>;
  return <div className="terminal-paste-backdrop"><div ref={element} className="terminal-paste-dialog" role="dialog" aria-modal="true" aria-label="多行粘贴">
    <strong>编辑后，选择粘贴方式</strong><span className="terminal-paste-target">{connectionName} · {state.text ? state.lines.length : 0} 行</span>
    <textarea className="terminal-paste-editor" data-paste-editor aria-label="待粘贴内容" aria-describedby={helpId} value={state.text} onChange={event => controller.edit(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" />
    <p id={helpId}>Enter 整体粘贴，Ctrl+Enter 逐行粘贴。点击编辑区可修改命令，Enter 换行。整体粘贴可能立即执行；逐行模式每行由你按 Enter 执行。</p>
    <div className="terminal-paste-buttons"><button type="button" className="button secondary" data-paste-cancel onClick={cancel}>取消</button><button type="button" className="button primary" data-paste-choice="all" aria-keyshortcuts="Enter" disabled={!state.text} onClick={() => { controller.choose('all'); terminal?.focus(); }}>整体粘贴<kbd>Enter</kbd></button><button type="button" className="button secondary" data-paste-choice="lines" aria-keyshortcuts="Control+Enter" disabled={!state.text} onClick={() => { controller.choose('lines'); terminal?.focus(); }}>逐行粘贴<kbd>Ctrl+Enter</kbd></button></div>
  </div></div>;
}
