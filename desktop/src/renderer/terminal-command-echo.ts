import type {IMarker, Terminal} from '@xterm/xterm';

/**
 * Read a single logical command already echoed between OSC B and OSC C. This is
 * display text, not a reconstruction of keystrokes or authoritative shell text.
 * The caller must also reject resize-away-and-back using its geometry counter.
 */
export function readCommandEcho(
  terminal: Terminal,
  input: {marker: IMarker; column: number; columns: number; prefix: string},
  end: {line: number; column: number},
): string | undefined {
  const buffer = terminal.buffer.normal, start = input.marker.line;
  if (terminal.buffer.active.type !== 'normal' || input.marker.isDisposed || terminal.cols !== input.columns
    || !Number.isInteger(start) || start < 0 || !Number.isInteger(input.column) || input.column < 0 || input.column > input.columns
    || !Number.isInteger(end.line) || end.line <= start || end.line >= buffer.length || end.column !== 0
    || end.line - start > 8193 || buffer.getLine(end.line)?.isWrapped !== false
    || typeof input.prefix !== 'string' || buffer.getLine(start)?.translateToString(false, 0, input.column) !== input.prefix) return;
  const cell = buffer.getNullCell();
  let text = '';
  for (let row = start; row < end.line; row++) {
    const line = buffer.getLine(row);
    if (!line || (row > start && !line.isWrapped)) return;
    const first = row === start ? input.column : 0;
    let last = Math.min(input.columns, line.length);
    if (first > last || (first < last && line.getCell(first, cell)?.getWidth() === 0)) return;
    if (row + 1 < end.line) {
      const next = buffer.getLine(row + 1);
      if (!next?.isWrapped) return;
      // A wide glyph can leave an empty final cell before wrapping. It is layout
      // padding; an explicit space has getChars() === ' ' and must be preserved.
      const tail = last > 0 ? line.getCell(last - 1, cell) : undefined;
      const padding = !!tail && tail.getWidth() === 1 && tail.getChars() === '';
      if (padding && next.getCell(0, cell)?.getWidth() === 2) last--;
    } else {
      // Remove only unused cells, including neither real spaces nor the second
      // cell of a wide character. Do not trim the resulting JavaScript string.
      while (last > first) {
        const tail = line.getCell(last - 1, cell);
        if (!tail || tail.getChars() !== '' || tail.getWidth() === 0) break;
        last--;
      }
    }
    for (let column = first; column < last;) {
      const value = line.getCell(column, cell);
      if (!value) return;
      const width = value.getWidth();
      if (width === 0) return;
      const chars = value.getChars();
      if (/[\u0000-\u001f\u007f-\u009f]/.test(chars)) return;
      text += chars || ' ';
      if (text.length > 8192) return;
      column += width;
    }
  }
  // Older Readline may horizontally scroll a long input, replacing the prompt
  // with "<" and leaving only the command's tail on screen. Prefix comparison
  // catches a replaced prompt; an empty prompt needs this conservative guard.
  // Home/Ctrl+A can instead retain the prompt and show only the input's beginning
  // with a right-truncation ">" indicator. Never offer that prefix as complete.
  if (!text || text.startsWith(' ') || (input.column === 0 && text.startsWith('<')) || text.endsWith('>')) return;
  return text;
}
