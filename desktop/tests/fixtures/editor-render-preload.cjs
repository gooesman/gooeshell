const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, request) => ipcRenderer.invoke('editor-fixture:call', method, request);

// This is the only mocked boundary: the actual dialog and CodeMirror editor are
// mounted in the renderer, while no user file or remote machine is contacted.
contextBridge.exposeInMainWorld('gooeshell', {
  readTextFile: request => invoke('readTextFile', request),
  writeTextFile: request => invoke('writeTextFile', request),
  saveTextCopy: request => invoke('saveTextCopy', request),
  editorState: request => { void invoke('editorState', request); },
  onEvent: () => () => {},
});
