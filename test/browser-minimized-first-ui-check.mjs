// A screenshot of a page first opened while JoltDesk is minimized: the page has never been drawn, so
// there is no frame to copy. The window is shown without focus just long enough, then minimized again.
import { _electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir=path.resolve('work/browser-minimized-first-'+Date.now());
await fs.mkdir(dir,{recursive:true});
const file=path.join(dir,'pond.html');
await fs.writeFile(file,'<!doctype html><title>Pond</title><body style="background:#cde"><h1>Koi pond</h1><canvas width="300" height="200" style="background:#38a"></canvas></body>');
const env={...process.env,BOLT_DATA_DIR:dir,BOLT_TEST_HOOKS:'1'};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await _electron.launch({args:['desktop.cjs'],env});
  const window=await app.firstWindow();
  await window.waitForLoadState('networkidle');
  const agent=(kind,input={})=>app.evaluate(async(_e,[kind,input])=>{
    try{return {ok:await global.__joltBrowserPane.agent(kind,input,null,{allowFiles:true})};}catch(error){return {error:error.message};}
  },[kind,input]);
  const minimized=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized());
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
  await new Promise(r=>setTimeout(r,1000));
  let result=await agent('browser-open',{url:pathToFileURL(file).href});
  assert.equal(result.error,undefined,result.error);
  result=await agent('browser-screenshot');
  assert.equal(result.error,undefined,'first screenshot while minimized: '+result.error);
  assert.ok(result.ok.image.length>1000,'the screenshot should hold an image');
  assert.ok(await minimized(),'the window must be minimized again afterwards');
  result=await agent('browser-screenshot');
  assert.equal(result.error,undefined,'second screenshot: '+result.error);
  assert.ok(await minimized(),'the window must stay minimized');
  console.log('BROWSER MINIMIZED-FIRST UI PASS: a never-drawn page can be captured while minimized, and the window is minimized again.');
}finally{await app?.close();}
