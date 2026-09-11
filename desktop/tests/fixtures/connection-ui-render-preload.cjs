const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gooeshell', {
  connections: () => ipcRenderer.invoke('connection-ui:catalog'),
  credentialStatus: profile => ipcRenderer.invoke('connection-ui:status', profile),
  forgetCredentials: id => ipcRenderer.invoke('connection-ui:forget', id),
  forgetJumpCredentials: jump => ipcRenderer.invoke('connection-ui:forget-jump', jump),
  chooseFiles: async () => [],
});
