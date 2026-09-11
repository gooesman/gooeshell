const {contextBridge,ipcRenderer}=require('electron');
const send=(method,...args)=>ipcRenderer.send('reconnect-fixture:call',method,args);
contextBridge.exposeInMainWorld('gooeshell',{
  terminalInput:(id,data)=>send('terminalInput',id,data),
  terminalBinaryInput:(id,data)=>send('terminalBinaryInput',id,data),
  terminalResize:(id,cols,rows)=>send('terminalResize',id,cols,rows),
  terminalAck:(id,bytes)=>send('terminalAck',id,bytes),
  fontCatalog:async()=>[],backgroundData:async()=>'',readClipboard:async()=>'',writeClipboard:async()=>{},
  onEvent:callback=>{
    const listener=(_event,value)=>callback(value);ipcRenderer.on('reconnect-fixture:event',listener);
    return()=>ipcRenderer.removeListener('reconnect-fixture:event',listener);
  },
});
