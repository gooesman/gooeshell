import type { ITheme } from '@xterm/xterm';
import type { AppSettings } from '../shared/types';
import { resolveTerminalPalette } from '../shared/terminal-palettes';

/** The containing terminal surface supplies this color behind optional artwork. */
export function terminalBackground(theme: AppSettings['theme'], palette?: string): string {
  return resolveTerminalPalette(theme, palette).colors.background;
}

export function terminalTheme(theme: AppSettings['theme'], palette?: string): ITheme {
  const colors = resolveTerminalPalette(theme, palette).colors;
  // Keep the xterm layers transparent so they do not obscure the background image.
  return { ...colors, background: `${colors.background}00` };
}
