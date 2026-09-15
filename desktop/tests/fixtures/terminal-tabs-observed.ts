import { Terminal as RealTerminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
export class Terminal extends RealTerminal {
  constructor(options: any) {
    super(options);
    const state = window as any;
    (state.__fixtureTerminals ||= []).push(this);
  }
}
