import type { ITheme } from '@xterm/xterm';
import type { AppSettings } from '../shared/types';

// Keep ANSI roles for shell output, with separate contrast for each background.
const dark: ITheme = {
  background: '#00000000', foreground: '#dddddd', cursor: '#eeeeee', cursorAccent: '#000000',
  selectionBackground: '#ffffff38', selectionInactiveBackground: '#ffffff22',
  black: '#202020', red: '#eb7f86', green: '#8dc9a0', yellow: '#e2c68e',
  blue: '#8eb7e5', magenta: '#c3a1de', cyan: '#7dc6c5', white: '#dddddd',
  brightBlack: '#888888', brightRed: '#f39b9f', brightGreen: '#afd9b5', brightYellow: '#eed9ad',
  brightBlue: '#b1cdef', brightMagenta: '#d8bee9', brightCyan: '#a4dddd', brightWhite: '#ffffff',
};
const light: ITheme = {
  background: '#ffffff00', foreground: '#242424', cursor: '#242424', cursorAccent: '#ffffff',
  selectionBackground: '#00000026', selectionInactiveBackground: '#00000016',
  black: '#242424', red: '#a52834', green: '#27633b', yellow: '#775800',
  blue: '#245da0', magenta: '#784694', cyan: '#126568', white: '#595959',
  brightBlack: '#6b6b6b', brightRed: '#bb3543', brightGreen: '#347245', brightYellow: '#866400',
  brightBlue: '#306eb1', brightMagenta: '#8959a4', brightCyan: '#237579', brightWhite: '#747474',
};

export function terminalTheme(theme: AppSettings['theme']): ITheme {
  return { ...(theme === 'light' ? light : dark) };
}
