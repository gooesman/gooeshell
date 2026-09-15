import { Terminal as RealTerminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
export class Terminal extends RealTerminal {
  constructor(options: any) {
    super(options);
    const fixture = window as any;
    (fixture.__pasteTerminals ||= []).push(this);
  }
}
