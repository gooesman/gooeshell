const { contextBridge, ipcRenderer } = require('electron');
const send = (method, ...args) => ipcRenderer.send('paste-fixture:call', method, args);
contextBridge.exposeInMainWorld('gooeshell', {
  terminalInput: (id, data) => send('terminalInput', id, data), terminalBinaryInput: (id, data) => send('terminalBinaryInput', id, data),
  terminalResize: (id, cols, rows) => send('terminalResize', id, cols, rows), terminalAck: (id, bytes) => send('terminalAck', id, bytes),
  fontCatalog: async () => [], backgroundData: async () => '', readClipboard: () => ipcRenderer.invoke('paste-fixture:clipboard'), writeClipboard: async () => {},
  onEvent: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('paste-fixture:event', listener); return () => ipcRenderer.removeListener('paste-fixture:event', listener); },
});
