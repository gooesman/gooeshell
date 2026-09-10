import { Terminal as RealTerminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';

// Expose public buffer/render APIs for assertions without modifying product code.
export class Terminal extends RealTerminal {
  constructor(options: any) {
    super(options);
    (window as any).__fixtureTerminal = this;
    (window as any).__fixtureRenders = 0;
    this.onRender(() => {
      (window as any).__fixtureRenders++;
      const buffer = this.buffer.active;
      const lines = [];
      for (let index = buffer.viewportY; index < Math.min(buffer.length, buffer.viewportY + this.rows); index++) lines.push(buffer.getLine(index)?.translateToString(true) || '');
      (window as any).__fixtureLastRenderedText = lines.join('\n');
    });
  }
}
