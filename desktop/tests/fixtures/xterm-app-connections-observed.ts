import { Terminal as RealTerminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';

// Keep the production parser, renderer and keyboard handling. Expose instances
// only so the native App regression can compare scrollback across shortcuts.
export class Terminal extends RealTerminal {
  constructor(options: any) {
    super(options);
    const fixture = window as any;
    (fixture.__appConnectionTerminals ||= []).push(this);
  }
}
