const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gooeshell', {
  credentialStatus: profile => ipcRenderer.invoke('connection-ui:status', profile),
  forgetCredentials: id => ipcRenderer.invoke('connection-ui:forget', id),
  chooseFiles: async () => [],
});
