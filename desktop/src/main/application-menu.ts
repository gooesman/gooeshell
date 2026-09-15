import { Menu, type MenuItemConstructorOptions } from 'electron';

/** The default Electron View menu has reload accelerators which can destroy the
 * renderer's live terminal workspace. Only expose native application/edit roles;
 * terminal and user-defined shortcuts continue receiving the original key event. */
export function configureApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs native edit roles for standard text-field clipboard/undo actions.
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: '窗口', submenu: [{ role: 'minimize' }, { type: 'separator' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
