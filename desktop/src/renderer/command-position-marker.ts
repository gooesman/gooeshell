import type {IBuffer, IBufferCell, IMarker, Terminal} from '@xterm/xterm';

/** Cell count carried into the next soft-wrapped row, excluding CJK wrap padding. */
function wrappedSpan(buffer: IBuffer, row: number, columns: number, cell: IBufferCell): number {
  const line = buffer.getLine(row), next = buffer.getLine(row + 1);
  const width = Math.min(columns, line?.length ?? columns);
  if (!line || !next?.isWrapped || width < 1) return width;
  const last = line.getCell(width - 1, cell);
  const emptyLast = !!last && last.getWidth() === 1 && last.getChars() === '';
  return emptyLast && next.getCell(0, cell)?.getWidth() === 2 ? width - 1 : width;
}

function locate(buffer: IBuffer, start: number, offset: number, columns: number, cell: IBufferCell) {
  let row = start, remaining = offset;
  while (row + 1 < buffer.length && buffer.getLine(row + 1)?.isWrapped) {
    const span = wrappedSpan(buffer, row, columns, cell);
    if (remaining < span) break;
    remaining -= span;
    row++;
  }
  return {row, column: remaining};
}

/**
 * Track a prompt's current cursor position across soft-wrap reflow. The owned
 * xterm marker anchors the logical line, which survives merging wrapped rows.
 * Removing that logical line from scrollback conservatively disposes this mark.
 */
export function registerCommandPositionMarker(terminal: Terminal): IMarker | undefined {
  const buffer = terminal.buffer.normal;
  if (terminal.buffer.active.type !== 'normal') return;
  const cursorRow = buffer.baseY + buffer.cursorY;
  let start = cursorRow;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  const anchor = terminal.registerMarker(start - cursorRow);
  if (!anchor) return;
  const cell = buffer.getNullCell();
  let columns = terminal.cols, offset = buffer.cursorX;
  for (let row = start; row < cursorRow; row++) offset += wrappedSpan(buffer, row, columns, cell);
  let frozen: {row: number; column: number} | undefined;
  let cache: {columns: number; start: number; length: number; line: number} | undefined;
  const resize = terminal.onResize(({cols}) => {
    if (anchor.isDisposed || cols === columns) return;
    let end = anchor.line;
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
    const cursor = buffer.baseY + buffer.cursorY;
    // xterm leaves the cursor's logical line alone by default. Preserve its
    // physical row, but include newly padded cells in the next reflow's offset.
    if (!terminal.options.reflowCursorLine && cursor >= anchor.line && cursor <= end) {
      const position = frozen
        ? {row: anchor.line + frozen.row, column: frozen.column}
        : locate(buffer, anchor.line, offset, columns, cell);
      frozen = {row: position.row - anchor.line, column: position.column};
      offset = position.column;
      for (let row = anchor.line; row < position.row; row++) offset += wrappedSpan(buffer, row, cols, cell);
    } else frozen = undefined;
    columns = cols;
    cache = undefined;
  });
  anchor.onDispose(() => resize.dispose());
  return {
    get id() { return anchor.id; },
    get isDisposed() { return anchor.isDisposed; },
    get line() {
      if (anchor.isDisposed) return -1;
      if (frozen) return anchor.line + frozen.row;
      if (cache?.columns === columns && cache.start === anchor.line && cache.length === buffer.length) return cache.line;
      const position = locate(buffer, anchor.line, offset, columns, cell);
      // A pending wrap can create another physical row without changing buffer
      // length. Only cache a position strictly inside the known row's width.
      if (position.column < wrappedSpan(buffer, position.row, columns, cell)) {
        cache = {columns, start: anchor.line, length: buffer.length, line: position.row};
      }
      return position.row;
    },
    onDispose: listener => anchor.onDispose(listener),
    dispose: () => anchor.dispose(),
  };
}
