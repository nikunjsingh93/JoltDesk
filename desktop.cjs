const {app,BrowserWindow,dialog,safeStorage,shell}=require('electron');
const path=require('node:path');const fs=require('node:fs/promises');const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {createWebTools}=require('./web-tools.cjs');
const {desktopDataDir}=require('./desktop-profile.cjs');
let backend,mainWindow;
// Keep the existing Windows taskbar identity and reuse a legacy profile in place.
if(process.platform==='win32')app.setAppUserModelId('local.bolt.desktop');
const dataPath=desktopDataDir(app.getPath('appData'),process.env.BOLT_DATA_DIR);
require('node:fs').mkdirSync(dataPath,{recursive:true});
app.setPath('userData',dataPath);
const primary=app.requestSingleInstanceLock();if(!primary)app.quit();
app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
app.whenReady().then(async()=>{
  if(!primary)return;
  const dataDir=app.getPath('userData'),keyFile=path.join(dataDir,'credential.bin');
  const usable=safeStorage.isEncryptionAvailable() && (process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');
  const vault=usable?{
    get:async()=>{try{return safeStorage.decryptString(await fs.readFile(keyFile));}catch{return '';}},
    set:async key=>fs.writeFile(keyFile,safeStorage.encryptString(key),{mode:0o600}),
    clear:async()=>fs.rm(keyFile,{force:true})
  }:undefined;
  if(app.isPackaged)process.env.BOLT_APPROVAL_PATH=path.join(process.resourcesPath,'app.asar.unpacked','approval.ts');
  const {startServer}=await import(pathToFileURL(path.join(__dirname,'server.mjs')).href);
  const native={
    webTools:createWebTools(BrowserWindow),
    pickFolder:async()=>{const r=await dialog.showOpenDialog({properties:['openDirectory']});return r.canceled?'':r.filePaths[0];},
    async fileAction(action,file){
      if(action==='reveal'){shell.showItemInFolder(file);return;}
      if(action==='open-with'&&process.platform==='win32'){
        const launcher=path.join(process.env.SystemRoot||'C:\\Windows','System32','rundll32.exe');
        await new Promise((resolve,reject)=>{
          const child=spawn(launcher,['shell32.dll,OpenAs_RunDLL',file],{stdio:'ignore',windowsHide:true});
          child.once('error',reject);
          child.once('spawn',()=>{child.unref();resolve();});
        });
        return;
      }
      const error=await shell.openPath(file);
      if(error)throw new Error(error);
    }
  };
  backend=await startServer({dataDir,vault,engineDir:app.isPackaged?path.join(process.resourcesPath,'pi-bolt'):undefined,requireBundled:app.isPackaged,native});
  const window=new BrowserWindow({width:1360,height:900,minWidth:760,minHeight:600,title:'JoltDesk',icon:path.join(__dirname,'public','joltdesk-icon.png'),backgroundColor:'#151515',autoHideMenuBar:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  mainWindow=window;
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//.test(url))shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==backend.url)event.preventDefault();});
  await window.loadURL(backend.url);
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>backend?.close());
