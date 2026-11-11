import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { mockProvider, testModel } from './mock-provider.mjs';

const dir=path.resolve('work/files-web-ui-'+Date.now());
const provider=await mockProvider();
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
const original=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'
  ?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
const actions=[];
const webRequests=[];
const source={url:'https://example.com/reference',title:'Example reference',snippet:'A public source.'};
const server=await startServer({
  dataDir:dir,autoStartUpdates:false,native:{
    fileAction:async(action,file)=>actions.push({action,file}),
    webTools:async(kind,input)=>{
      webRequests.push({kind,input});
      return kind==='search'?{sources:[source]}:{...source,text:'Example page text.',links:[]};
    },
    browser:{agent:async(kind,input)=>{
      webRequests.push({kind,input});
      return {...source,text:'Rendered page text.',links:[]};
    }}
  }
});
const env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});
  const page=await app.firstWindow();
  await page.locator('#settings').click();
  await page.locator('#api-key').fill('sk-fake');
  await page.locator('#connect-button').click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await page.locator('#permission').selectOption('bypass');
  await expect(page.locator('#toast')).toContainText('Bypass active');
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-inspector').click();

  const send=async(text,previous=provider.requests.length)=>{
    await page.locator('#prompt').fill(text);
    await page.locator('#send').click();
    await expect.poll(()=>provider.requests.length).toBeGreaterThan(previous);
    await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
  };
  provider.tool('write',{path:'example file.txt',content:'File action fixture.'});
  await send('Write a fixture file.');
  const file=page.locator('[data-file-path="example file.txt"]');
  await expect(file.locator('time')).toContainText('Last edited');
  const modified=await fs.stat(path.join(dir,'workspace','example file.txt'));
  assert.equal(await file.locator('time').getAttribute('datetime'),new Date(modified.mtimeMs).toISOString());
  await file.locator('button').click({button:'right'});
  await page.locator('[data-file-action="reveal"]').click();
  await expect.poll(()=>actions.length).toBe(1);
  await file.locator('button').click();
  await page.locator('[data-file-action="open-with"]').click();
  await expect.poll(()=>actions.length).toBe(2);
  assert.deepEqual(actions.map(a=>a.action),['reveal','open-with']);
  assert.ok(actions.every(a=>a.file===path.join(dir,'workspace','example file.txt')));
  const declared=body=>(body.tools||[]).map(tool=>tool.name||tool.function?.name);
  assert.ok(provider.requests.every(body=>!declared(body).includes('web_search')));

  await page.locator('#web-tools').check();
  provider.tool('web_search',{query:'Example reference'});
  await send('Find an example reference.');
  assert.deepEqual(webRequests[0],{kind:'search',input:{query:'Example reference'}});
  await expect(page.locator('#inspector-sources')).toContainText('Example reference');
  provider.tool('browse_page',{url:source.url});
  await send('Read that page.');
  assert.deepEqual(webRequests[1],{kind:'browse',input:{url:source.url}});
  assert.ok(provider.requests.some(body=>declared(body).includes('browse_page')));
  provider.tool('browser_open',{url:source.url});
  await send('Open that page in the browser.');
  assert.deepEqual(webRequests[2],{kind:'browser-open',input:{url:source.url}});
  provider.tool('browser_read',{});
  await send('Read the page I have open.');
  assert.deepEqual(webRequests[3],{kind:'browser-read',input:{}});
  assert.ok(provider.requests.some(body=>declared(body).includes('browser_read')));
  await page.reload();
  await page.locator('.open-chat').click();
  await expect(page.locator('#web-tools')).toBeChecked();
  console.log('FILES AND WEB UI PASS: real file modification time, left and right-click actions, optional web and browser tools, sources and persistence.');
}finally{
  await app?.close();
  server.close();
  provider.close();
  globalThis.fetch=original;
}
