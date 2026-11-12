const {app,BrowserWindow}=require('electron');
const path=require('node:path');
// Give each check its own browser profile so saved panel tabs and widths do not leak between checks.
if(process.env.BOLT_DATA_DIR)app.setPath('userData',path.join(process.env.BOLT_DATA_DIR,'ui-shell-profile'));
app.whenReady().then(()=>{const win=new BrowserWindow({width:1360,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadURL(process.env.BOLT_TEST_URL);});
app.on('window-all-closed',()=>app.quit());
