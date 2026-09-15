import { useEffect, useRef } from 'react';
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
  choose(mode: 'all' | 'lines') {
    const state = this.state; if (state?.mode !== 'choose') return;
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
  const cancel = () => { controller.cancel(); terminal?.focus(); };
  useEffect(() => {
    if (state.mode !== 'choose') return;
    element.current?.querySelector<HTMLButtonElement>('[data-paste-choice="lines"]')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key === 'Tab') {
        const buttons = [...element.current!.querySelectorAll<HTMLButtonElement>('button')];
        event.preventDefault(); event.stopPropagation();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    element.current?.addEventListener('keydown', keyboard);
    return () => element.current?.removeEventListener('keydown', keyboard);
  }, [state.mode]);
  if (state.mode === 'lines') return <div className="terminal-paste-queue" role="status" data-paste-line={state.index + 1}>
    <div><strong>逐行粘贴 · {state.index + 1} / {state.lines.length}</strong><span>{state.submitted ? '当前行已提交；终端准备好后，再填入下一行。' : '当前行已填入，按回车执行。Ctrl+C 可取消剩余行。'}</span></div>
    <button type="button" className="button small secondary" disabled={!state.submitted} onClick={() => { controller.next(); terminal?.focus(); }}>填入下一行</button>
    <button type="button" className="button small secondary" onClick={cancel}>取消剩余</button>
  </div>;
  return <div className="terminal-paste-backdrop"><div ref={element} className="terminal-paste-dialog" role="dialog" aria-modal="true" aria-label="多行粘贴">
    <strong>如何粘贴这 {state.lines.length} 行内容？</strong><span className="terminal-paste-target">{connectionName}</span>
    <pre aria-label="待粘贴内容">{state.text.slice(0, 12000)}{state.text.length > 12000 ? '\n…预览已截断，粘贴内容保持完整' : ''}</pre>
    <p>整体粘贴保留原文和换行；终端中的程序可能立即执行。逐行粘贴由你按回车执行，准备好后手动填入下一行。</p>
    <div className="terminal-paste-buttons"><button className="button secondary" onClick={cancel}>取消</button><button className="button secondary" data-paste-choice="all" onClick={() => { controller.choose('all'); terminal?.focus(); }}>整体粘贴</button><button className="button primary" data-paste-choice="lines" onClick={() => { controller.choose('lines'); terminal?.focus(); }}>逐行粘贴</button></div>
  </div></div>;
}
