const { contextBridge, ipcRenderer } = require('electron');
const call = (method, value) => ipcRenderer.invoke('connections-flow:call', method, value);
contextBridge.exposeInMainWorld('gooeshell', Object.fromEntries([
  'connections', 'saveConnection', 'connect', 'cancelConnect', 'disconnect', 'saveCredentials', 'sendSudoPassword', 'credentialStatus',
].map(method => [method, value => call(method, value)])));
