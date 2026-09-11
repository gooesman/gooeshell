const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gooeshell', {
  commandLibrary: () => ipcRenderer.invoke('command-ui:read'),
  saveCommandGroup: value => ipcRenderer.invoke('command-ui:save-group', value),
  deleteCommandGroup: id => ipcRenderer.invoke('command-ui:delete-group', id),
  saveCommand: value => ipcRenderer.invoke('command-ui:save-command', value),
  deleteCommand: id => ipcRenderer.invoke('command-ui:delete-command', id),
  writeClipboard: text => ipcRenderer.invoke('command-ui:copy', text),
});
