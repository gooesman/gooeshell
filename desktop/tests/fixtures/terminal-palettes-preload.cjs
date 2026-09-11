const {contextBridge,ipcRenderer}=require('electron');
const send=(method,...args)=>ipcRenderer.send('palette-fixture:call',method,args);
contextBridge.exposeInMainWorld('gooeshell',{
  terminalInput:(id,data)=>send('terminalInput',id,data),
  terminalBinaryInput:(id,data)=>send('terminalBinaryInput',id,data),
  terminalResize:(id,cols,rows)=>send('terminalResize',id,cols,rows),
  terminalAck:(id,bytes)=>send('terminalAck',id,bytes),
  fontCatalog:async()=>[],
  backgroundData:async()=>`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#f0f0f0"/></svg>')}`,
  readClipboard:async()=>'',writeClipboard:async()=>{},
  onEvent:callback=>{
    const listener=(_event,value)=>callback(value);ipcRenderer.on('palette-fixture:event',listener);
    return()=>ipcRenderer.removeListener('palette-fixture:event',listener);
  },
});
