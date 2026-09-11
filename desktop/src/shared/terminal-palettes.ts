export type TerminalPaletteId = 'follow-interface' | 'midnight' | 'daylight' | 'graphite' | 'classic' | 'warm';

export interface TerminalColors {
  background: string; foreground: string; cursor: string; cursorAccent: string;
  selectionBackground: string; selectionInactiveBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface TerminalPalette {
  id: Exclude<TerminalPaletteId, 'follow-interface'>;
  name: string;
  description: string;
  colors: Readonly<TerminalColors>;
}

// These palettes belong to Gooeshell. The first two preserve the original defaults.
export const terminalPalettes: readonly TerminalPalette[] = [
  {
    id: 'midnight', name: '纯黑', description: '纯黑背景，柔和的文字颜色',
    colors: {
      background: '#000000', foreground: '#dddddd', cursor: '#eeeeee', cursorAccent: '#000000',
      selectionBackground: '#ffffff38', selectionInactiveBackground: '#ffffff22',
      black: '#202020', red: '#eb7f86', green: '#8dc9a0', yellow: '#e2c68e',
      blue: '#8eb7e5', magenta: '#c3a1de', cyan: '#7dc6c5', white: '#dddddd',
      brightBlack: '#888888', brightRed: '#f39b9f', brightGreen: '#afd9b5', brightYellow: '#eed9ad',
      brightBlue: '#b1cdef', brightMagenta: '#d8bee9', brightCyan: '#a4dddd', brightWhite: '#ffffff',
    },
  },
  {
    id: 'daylight', name: '白昼', description: '白色背景，深色文字',
    colors: {
      background: '#ffffff', foreground: '#242424', cursor: '#242424', cursorAccent: '#ffffff',
      selectionBackground: '#00000026', selectionInactiveBackground: '#00000016',
      black: '#242424', red: '#a52834', green: '#27633b', yellow: '#775800',
      blue: '#245da0', magenta: '#784694', cyan: '#126568', white: '#595959',
      brightBlack: '#6b6b6b', brightRed: '#bb3543', brightGreen: '#347245', brightYellow: '#866400',
      brightBlue: '#306eb1', brightMagenta: '#8959a4', brightCyan: '#237579', brightWhite: '#747474',
    },
  },
  {
    id: 'graphite', name: '石墨', description: '中性深灰，低调清晰',
    colors: {
      background: '#171717', foreground: '#dedede', cursor: '#eeeeee', cursorAccent: '#171717',
      selectionBackground: '#ffffff32', selectionInactiveBackground: '#ffffff20',
      black: '#303030', red: '#dc8b8b', green: '#a4bd94', yellow: '#d8bd8e',
      blue: '#92b5d5', magenta: '#bca4cf', cyan: '#96c3c1', white: '#dedede',
      brightBlack: '#909090', brightRed: '#ebb0b0', brightGreen: '#c1d4b5', brightYellow: '#e6d2af',
      brightBlue: '#b7cfe5', brightMagenta: '#d4c1e1', brightCyan: '#b9d9d7', brightWhite: '#ffffff',
    },
  },
  {
    id: 'classic', name: '经典', description: '纯黑背景，更鲜明的 ANSI 颜色',
    colors: {
      background: '#000000', foreground: '#dddddd', cursor: '#ffffff', cursorAccent: '#000000',
      selectionBackground: '#ffffff40', selectionInactiveBackground: '#ffffff24',
      black: '#202020', red: '#e36b6b', green: '#6fc381', yellow: '#ddbd65',
      blue: '#659cef', magenta: '#c785dc', cyan: '#65c6c9', white: '#dddddd',
      brightBlack: '#909090', brightRed: '#ff9393', brightGreen: '#9ce4a9', brightYellow: '#f5da88',
      brightBlue: '#92baff', brightMagenta: '#e4aff4', brightCyan: '#93e6e7', brightWhite: '#ffffff',
    },
  },
  {
    id: 'warm', name: '暖灰', description: '暖灰背景，柔和的米白文字',
    colors: {
      background: '#211e1b', foreground: '#e2d9cb', cursor: '#f0e7db', cursorAccent: '#211e1b',
      selectionBackground: '#fff3df30', selectionInactiveBackground: '#fff3df1c',
      black: '#3a3530', red: '#dd9385', green: '#b0c097', yellow: '#dfc28e',
      blue: '#9cb9d5', magenta: '#c9a6bf', cyan: '#98c3b9', white: '#e2d9cb',
      brightBlack: '#a0978b', brightRed: '#edb4a9', brightGreen: '#cbd7b8', brightYellow: '#efdbb6',
      brightBlue: '#bfd2e5', brightMagenta: '#dec3d7', brightCyan: '#bddad2', brightWhite: '#fff8ed',
    },
  },
];

export function normalizeTerminalPalette(value: unknown): TerminalPaletteId {
  return value === 'follow-interface' || terminalPalettes.some(palette => palette.id === value)
    ? value as TerminalPaletteId : 'follow-interface';
}

export function resolveTerminalPalette(theme: 'dark' | 'light', value?: string): TerminalPalette {
  const id = normalizeTerminalPalette(value);
  const selected = id === 'follow-interface' ? (theme === 'light' ? 'daylight' : 'midnight') : id;
  return terminalPalettes.find(palette => palette.id === selected)!;
}
