import type { AppSettings } from './types';
export const defaultSettings: AppSettings = {
  theme: 'dark',
  showConnectionHistory: true, filesToggleIconOnly: true, fontWeight: 400,
  shortcutSchemaVersion: 2,
  fontFamily: 'DejaVu Sans Mono', chineseFont: 'Microsoft YaHei', fontSize: 14,
  lineHeight: 1.1, cursorBlink: false, copyOnSelect: false, rightClickPaste: false,
  backgroundImage: '', backgroundOpacity: 0.15,
  shortcuts: {connect:'Ctrl+Shift+P',settings:'Ctrl+Shift+F1',previousTab:'Ctrl+Shift+ArrowLeft',nextTab:'Ctrl+Shift+ArrowRight',files:'Ctrl+Shift+E',fullscreen:'F11',zen:'Ctrl+Shift+F11',copy:'Ctrl+Shift+C',paste:'Ctrl+Shift+V',search:'Ctrl+Shift+F',fontUp:'Ctrl+=',fontDown:'Ctrl+-'}
};

export function migrateDefaultShortcuts(shortcuts: Record<string, string>, schemaVersion?: number) {
  const result = { ...shortcuts };
  if ((schemaVersion ?? 0) >= 2) return result;
  for (const [action, previous] of [['connect', 'Ctrl+Shift+N'], ['settings', 'Ctrl+,']]) {
    const next = defaultSettings.shortcuts[action];
    if (result[action] === previous && !Object.entries(result).some(([id, value]) => id !== action && value.toLowerCase() === next.toLowerCase())) result[action] = next;
  }
  return result;
}
