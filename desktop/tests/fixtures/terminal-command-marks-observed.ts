import { Terminal as RealTerminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';

// Keep xterm's actual parser, buffers and renderer. Observe native key routing
// and optionally defer ACK delivery across the replacement of a transport.
export class Terminal extends RealTerminal {
  constructor(options: any) {
    super(options);
    const fixture = window as any;
    (fixture.__marksTerminals ||= []).push(this);
    fixture.__marksKeyDecisions ||= [];
    fixture.__marksDeferredCallbacks ||= [];
    this.onRender(() => { fixture.__marksRenderCount = (fixture.__marksRenderCount || 0) + 1; });
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    super.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      const result = handler(event), fixture = window as any;
      fixture.__marksKeyDecisions.push({ terminal: fixture.__marksTerminals.indexOf(this), type: event.type,
        code: event.code, ctrl: event.ctrlKey, shift: event.shiftKey, result });
      return result;
    });
  }
  write(data: string | Uint8Array, callback?: () => void) {
    super.write(data, callback ? () => {
      const fixture = window as any;
      if (fixture.__marksHoldCallbacks) fixture.__marksDeferredCallbacks.push(callback); else callback();
    } : undefined);
  }
}
