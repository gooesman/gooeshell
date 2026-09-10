const { contextBridge, ipcRenderer } = require('electron');
const send = (method, ...args) => ipcRenderer.send('terminal-fixture:call', method, args);
contextBridge.exposeInMainWorld('gooeshell', {
  terminalInput: (id, data) => send('terminalInput', id, data),
  terminalBinaryInput: (id, data) => send('terminalBinaryInput', id, data),
  terminalResize: (id, cols, rows) => send('terminalResize', id, cols, rows),
  terminalAck: (id, bytes) => send('terminalAck', id, bytes),
  fontCatalog: () => ipcRenderer.invoke('terminal-fixture:font-catalog'),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('terminal-fixture:event', listener);
    return () => ipcRenderer.removeListener('terminal-fixture:event', listener);
  },
  backgroundData: async () => '', readClipboard: async () => '', writeClipboard: async () => {},
});
contextBridge.exposeInMainWorld('terminalFixture', { connect: () => ipcRenderer.invoke('terminal-fixture:connect') });
