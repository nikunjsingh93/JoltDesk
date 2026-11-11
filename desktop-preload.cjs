// Exposes only the built-in browser commands to the JoltDesk window.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('joltBrowser',{
  command:(name,arg)=>ipcRenderer.invoke('browser:command',name,arg),
  onEvent:callback=>{
    const listener=(_event,message)=>callback(message);
    ipcRenderer.on('browser:event',listener);
    return ()=>ipcRenderer.removeListener('browser:event',listener);
  }
});
