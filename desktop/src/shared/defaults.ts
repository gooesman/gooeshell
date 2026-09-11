import type { AppSettings } from './types';
export const defaultSettings: AppSettings = {
  theme: 'dark', terminalPalette: 'follow-interface',
  showConnectionHistory: true, filesToggleIconOnly: true, fontWeight: 400, chineseFontWeight: 400,
  shortcutSchemaVersion: 2,
  fontFamily: 'DejaVu Sans Mono', chineseFont: 'Microsoft YaHei', fontSize: 14,
  lineHeight: 1.1, cursorBlink: false, copyOnSelect: false, rightClickPaste: false,
  backgroundImage: '', backgroundOpacity: 0.15, sudoPasswordSubmit: false,
  shortcuts: {commands:'Ctrl+Shift+M',connect:'Ctrl+Shift+P',settings:'Ctrl+Shift+F1',sidebar:'Ctrl+Shift+[',terminalHeader:'Ctrl+Shift+]',previousTab:'Ctrl+Shift+ArrowLeft',nextTab:'Ctrl+Shift+ArrowRight',files:'Ctrl+Shift+E',fullscreen:'F11',zen:'Ctrl+Shift+F11',copy:'Ctrl+Shift+C',paste:'Ctrl+Shift+V',search:'Ctrl+Shift+F',fontUp:'Ctrl+=',fontDown:'Ctrl+-',reconnect:'Ctrl+Shift+R',sudoPassword:'Ctrl+Alt+P'}
};

export function normalizeShortcut(value: string): string {
  const parts = value.split('+');
  if (!parts.slice(0, -1).some(part => part.toLowerCase() === 'shift')) return value;
  const key = parts.at(-1);
  if (key === '{') parts[parts.length - 1] = '[';
  else if (key === '}') parts[parts.length - 1] = ']';
  return parts.join('+');
}

export function migrateDefaultShortcuts(shortcuts: Record<string, string>, schemaVersion?: number) {
  const result = { ...shortcuts };
  if ((schemaVersion ?? 0) >= 2) return result;
  for (const [action, previous] of [['connect', 'Ctrl+Shift+N'], ['settings', 'Ctrl+,']]) {
    const next = defaultSettings.shortcuts[action];
    if (result[action] === previous && !Object.entries(result).some(([id, value]) => id !== action && value.toLowerCase() === next.toLowerCase())) result[action] = next;
  }
  return result;
}
