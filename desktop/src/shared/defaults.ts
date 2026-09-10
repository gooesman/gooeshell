import type { AppSettings } from './types';
export const defaultSettings: AppSettings = {
  theme: 'dark',
  fontFamily: 'DejaVu Sans Mono', chineseFont: 'Microsoft YaHei', fontSize: 14,
  lineHeight: 1.1, cursorBlink: false, copyOnSelect: false, rightClickPaste: false,
  backgroundImage: '', backgroundOpacity: 0.15,
  shortcuts: {connect:'Ctrl+Shift+N',settings:'Ctrl+,',files:'Ctrl+Shift+E',fullscreen:'F11',zen:'Ctrl+Shift+F11',copy:'Ctrl+Shift+C',paste:'Ctrl+Shift+V',search:'Ctrl+Shift+F',fontUp:'Ctrl+=',fontDown:'Ctrl+-'}
};
