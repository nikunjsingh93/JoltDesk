// Agent browser actions in the real desktop shell: open, read, type, click, press, scroll,
// screenshot, local files and address rules. Uses a loopback shop-like fixture.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const page=(title,body,script='')=>`<!doctype html><title>${title}</title><body style="font-family:sans-serif;margin:20px">${body}<script>${script}</script></body>`;
const site=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x');
  res.writeHead(200,{'Content-Type':'text/html'});
  if(url.pathname==='/results'){
    const items=Array.from({length:40},(_,i)=>`<p>Item ${i+1}: ${url.searchParams.get('q')} model ${i+1}</p>`).join('');
    res.end(page('Results',`<main><h1>Results for ${url.searchParams.get('q')}</h1><button id="add">Add to cart</button><p id="cart">Cart is empty</p><label>Password <input type="password" id="pw"></label>${items}<p id="end">End of results</p></main>`,
      `document.getElementById('add').addEventListener('click',()=>{document.getElementById('cart').textContent='Added to cart';});`));
    return;
  }
  res.end(page('Shop home',`<header><form action="/results"><input name="q" aria-label="Search products"><button>Go</button></form></header><main><h1>Welcome to the shop</h1></main>`));
});
await new Promise(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${site.address().port}`;
const dir=path.resolve('work/browser-actions-'+Date.now());
await fs.mkdir(dir,{recursive:true});
const localFile=path.join(dir,'koi.html');
await fs.writeFile(localFile,page('Koi pond','<main><h1>Koi pond simulator</h1><canvas width="300" height="200"></canvas></main>'));
const env={...process.env,BOLT_DATA_DIR:dir,BOLT_BROWSER_HOME:origin+'/',BOLT_TEST_HOOKS:'1'};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const ref=(elements,pattern)=>{const line=elements.split('\n').find(l=>pattern.test(l));assert.ok(line,`No element matching ${pattern} in:\n${elements}`);return Number(/^\[(\d+)\]/.exec(line)[1]);};
try{
  app=await _electron.launch({args:['desktop.cjs'],env});
  const window=await app.firstWindow();
  await window.waitForLoadState('networkidle');
  const agent=(kind,input={},options={allowFiles:true})=>app.evaluate(async(_electron,[kind,input,options])=>{
    try{return {ok:await global.__joltBrowserPane.agent(kind,input,null,options)};}catch(error){return {error:error.message};}
  },[kind,input,options]);

  let result=await agent('browser-open',{url:origin+'/'});
  assert.equal(result.error,undefined,result.error);
  assert.equal(result.ok.title,'Shop home');
  await expect(window.locator('#browser-view')).toBeVisible();
  const search=ref(result.ok.elements,/textbox "Search products"/);

  result=await agent('browser-type',{element:search,text:'thinkpad x1',submit:true});
  assert.equal(result.error,undefined,result.error);
  assert.match(result.ok.url,/\/results\?q=thinkpad\+x1$/);
  assert.match(result.ok.text,/Results for thinkpad x1/);

  const add=ref(result.ok.elements,/button "Add to cart"/);
  result=await agent('browser-click',{element:add});
  assert.match(result.ok.text,/Added to cart/);

  const password=ref(result.ok.elements,/password/);
  result=await agent('browser-type',{element:password,text:'secret'});
  assert.match(result.error,/password fields/);
  result=await agent('browser-type',{element:999,text:'x'});
  assert.match(result.error,/no longer on the page/);

  result=await agent('browser-scroll',{direction:'down',pages:2});
  assert.ok(result.ok.scroll.top>0,'page should scroll down');
  result=await agent('browser-press',{key:'End'});
  assert.ok(result.ok.scroll.top+result.ok.scroll.view>=result.ok.scroll.height-10,'End should reach the bottom');
  result=await agent('browser-press',{key:'F13'});
  assert.match(result.error,/Use one of these keys/);

  result=await agent('browser-screenshot');
  assert.equal(result.error,undefined,result.error);
  assert.equal(result.ok.mimeType,'image/jpeg');
  assert.ok(Buffer.from(result.ok.image,'base64').length>2000);

  // Screenshots still work while the user looks at another tab or the window is minimized.
  await window.locator('#panel-files').click();
  result=await agent('browser-screenshot');
  assert.equal(result.error,undefined,'with the Files tab showing: '+result.error);
  assert.ok(Buffer.from(result.ok.image,'base64').length>2000);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
  await new Promise(r=>setTimeout(r,800));
  result=await agent('browser-screenshot');
  assert.equal(result.error,undefined,'with the window minimized: '+result.error);
  assert.ok(Buffer.from(result.ok.image,'base64').length>2000);
  assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()),'the screenshot must not restore the window');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
  // The case from real use: the panel shows another tab, then the window is minimized.
  await window.locator('#panel-files').click();
  await new Promise(r=>setTimeout(r,300));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
  await new Promise(r=>setTimeout(r,800));
  result=await agent('browser-screenshot');
  assert.equal(result.error,undefined,'with another tab showing and the window minimized: '+result.error);
  assert.ok(Buffer.from(result.ok.image,'base64').length>2000);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
  await expect(window.locator('#browser-view')).toBeVisible();
  // When the view has been taken off the window, the screenshot puts it back and retries.
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];for(const view of [...w.contentView.children])w.contentView.removeChildView(view);});
  result=await agent('browser-screenshot');
  assert.equal(result.error,undefined,'with the view detached: '+result.error);
  assert.ok(Buffer.from(result.ok.image,'base64').length>2000);

  // Local files need file permission; LAN addresses stay blocked.
  result=await agent('browser-open',{url:localFile},{allowFiles:false});
  assert.match(result.error,/Read files permission/);
  result=await agent('browser-open',{url:localFile});
  assert.equal(result.ok.title,'Koi pond');
  result=await agent('browser-read');
  assert.match(result.ok.text,/Koi pond simulator/);
  result=await agent('browser-open',{url:'http://192.168.1.1/'});
  assert.match(result.error,/outside the public web|standard port/);
  result=await agent('browser-open',{url:'ftp://example.com/'});
  assert.match(result.error,/web pages and local files/);
  console.log('BROWSER ACTIONS UI PASS: open, numbered elements, type with Enter, click, password and stale-element refusals, scroll, keys, screenshot, local files with permission, LAN and scheme blocks.');
}finally{
  await app?.close();
  site.close();
}
