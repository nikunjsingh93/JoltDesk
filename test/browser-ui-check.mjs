// Drives the real desktop shell with an isolated profile and a loopback page fixture.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const {normalizeAddress}=createRequire(import.meta.url)('../browser-pane.cjs');
assert.equal(normalizeAddress('example.com/docs'),'https://example.com/docs');
assert.equal(normalizeAddress('localhost:5173'),'http://localhost:5173/');
assert.equal(normalizeAddress('127.0.0.1:8080/app'),'http://127.0.0.1:8080/app');
assert.match(normalizeAddress('electron webcontentsview'),/^https:\/\/duckduckgo\.com\/\?q=electron\+webcontentsview$/);
assert.throws(()=>normalizeAddress('file:///C:/Windows/win.ini'),/HTTP and HTTPS/);

const pages={
  '/':'<title>Fixture home</title><main><h1>Home fixture</h1></main>',
  '/article':'<title>Fixture article</title><main><h1>Rendered heading</h1><p id="late"></p><a href="/">Back home</a></main><script>document.getElementById("late").textContent="Text added by script";</script>'
};
const site=http.createServer((req,res)=>{const body=pages[req.url];res.writeHead(body?200:404,{'Content-Type':'text/html'});res.end(body||'missing');});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${site.address().port}`;
const dir=path.resolve('work/browser-ui-'+Date.now());
await fs.mkdir(dir,{recursive:true});
const env={...process.env,BOLT_DATA_DIR:dir,BOLT_BROWSER_HOME:origin+'/'};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await _electron.launch({args:['desktop.cjs'],env});
  const page=await app.firstWindow();
  const views=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.length);
  await expect(page.locator('#status')).not.toHaveText('');
  await page.waitForLoadState('networkidle');
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-inspector').click();
  await expect(page.locator('#panel-browser')).toBeVisible();
  await expect.poll(views).toBe(0);
  await page.locator('#panel-browser').click();
  await expect(page.locator('#browser-view')).toBeVisible();
  await expect(page.locator('#files-view')).toBeHidden();
  await expect(page.locator('.browser-tab.active')).toContainText('Fixture home');
  await expect.poll(views).toBe(1);

  await page.locator('#browser-address').fill(origin.replace('http://','')+'/article');
  await page.locator('#browser-address').press('Enter');
  await expect(page.locator('.browser-tab.active')).toContainText('Fixture article');
  await expect(page.locator('#browser-address')).toHaveValue(origin+'/article');
  await expect(page.locator('#browser-back')).toBeEnabled();

  await page.locator('#browser-attach').click();
  await expect(page.locator('#attachments')).toContainText('Fixture article.md');
  const read=await page.evaluate(()=>window.joltBrowser.command('read'));
  assert.match(read.text,/Text added by script/);
  assert.deepEqual(read.links,[{url:origin+'/',title:'Back home'}]);

  await page.evaluate(url=>window.joltBrowser.command('new-tab',url),origin+'/');
  await expect(page.locator('.browser-tab')).toHaveCount(2);
  await expect.poll(views).toBe(1);
  await page.locator('.browser-tab').first().locator('[data-tab]').click();
  await expect(page.locator('#browser-address')).toHaveValue(origin+'/article');
  await page.locator('.browser-tab').nth(1).locator('.browser-tab-close').click();
  await expect(page.locator('.browser-tab')).toHaveCount(1);

  await page.locator('#browser-address').fill('http://127.0.0.1:1/');
  await page.locator('#browser-address').press('Enter');
  await expect(page.locator('#browser-message')).not.toBeEmpty();
  await expect.poll(views).toBe(0);
  await page.locator('#browser-back').click();
  await expect(page.locator('.browser-tab.active')).toContainText('Fixture article');
  await expect.poll(views).toBe(1);

  await page.locator('#settings').click();
  await expect.poll(views).toBe(0);
  await page.locator('#settings-dialog .close-dialog').click();
  await expect.poll(views).toBe(1);
  await page.locator('#panel-files').click();
  await expect(page.locator('#files-view')).toBeVisible();
  await expect(page.locator('#browser-view')).toBeHidden();
  await expect.poll(views).toBe(0);
  await page.locator('#panel-browser').click();
  await expect.poll(views).toBe(1);
  await page.locator('#close-inspector').click();
  await expect(page.locator('#work-panel')).toBeHidden();
  await expect.poll(views).toBe(0);
  await page.locator('#messages').evaluate(el=>{el.innerHTML='<a href="'+location.origin.replace(/:d+$/,'')+'">x</a>';});
  await page.evaluate(url=>{const a=document.querySelector('#messages a');a.href=url;},origin+'/article');
  await page.locator('#messages a').click();
  await expect(page.locator('#browser-view')).toBeVisible();
  await expect(page.locator('.browser-tab.active')).toContainText('Fixture article');
  await expect.poll(views).toBe(1);
  const unauthorized=await app.evaluate(async({BrowserWindow},preload)=>{
    const probe=new BrowserWindow({show:false,webPreferences:{preload,sandbox:true}});
    await probe.loadURL('data:text/html,probe');
    try{await probe.webContents.executeJavaScript("window.joltBrowser.command('state')");return 'allowed';}catch(error){return String(error.message);}finally{probe.destroy();}
  },path.resolve('desktop-preload.cjs'));
  assert.match(unauthorized,/limited to JoltDesk/);
  console.log('BROWSER UI PASS: address normalization, tabs, navigation, script-rendered page reading, chat attachment, load errors, shared Files/Browser panel, chat links, dialog overlay and sender checks.');
}finally{
  await app?.close();
  site.close();
}
