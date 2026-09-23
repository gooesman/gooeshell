const { contextBridge, ipcRenderer } = require('electron');
const send = (method, ...args) => ipcRenderer.send('command-marks-fixture:call', method, args);
contextBridge.exposeInMainWorld('gooeshell', {
  terminalInput: (id, data) => send('terminalInput', id, data),
  terminalBinaryInput: (id, data) => send('terminalBinaryInput', id, data),
  terminalResize: (id, cols, rows) => send('terminalResize', id, cols, rows),
  terminalAck: (id, bytes) => send('terminalAck', id, bytes),
  fontCatalog: async () => [], backgroundData: async () => '', readClipboard: async () => '',
  // This fixture never touches the user's clipboard or connection settings.
  writeClipboard: async text => send('writeClipboard', text),
  onEvent: callback => {
    // A batch is delivered in one renderer task to reproduce a disconnect that
    // arrives before xterm's asynchronous write queue has parsed the last bytes.
    const listener = (_event, value) => { for (const event of Array.isArray(value) ? value : [value]) callback(event); };
    ipcRenderer.on('command-marks-fixture:event', listener);
    return () => ipcRenderer.removeListener('command-marks-fixture:event', listener);
  },
});
