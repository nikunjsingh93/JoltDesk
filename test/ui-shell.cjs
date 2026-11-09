const {app,BrowserWindow}=require('electron');
app.whenReady().then(()=>{const win=new BrowserWindow({width:1360,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadURL(process.env.BOLT_TEST_URL);});
app.on('window-all-closed',()=>app.quit());
