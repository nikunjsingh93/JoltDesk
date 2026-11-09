import { spawn } from 'node:child_process';
import electron from 'electron';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,['.'],{env,stdio:'inherit',windowsHide:false});
child.on('exit',code=>process.exit(code||0));child.on('error',e=>{console.error(e.message);process.exit(1);});
