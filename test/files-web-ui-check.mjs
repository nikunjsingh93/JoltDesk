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
      if(kind==='browser-screenshot')return {url:source.url,title:source.title,image:Buffer.from('fake-jpeg').toString('base64'),mimeType:'image/jpeg'};
      return {...source,text:'Rendered page text.',links:[],elements:'[0] button "Go"',scroll:{top:0,view:800,height:2400}};
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
  assert.ok(JSON.stringify(provider.requests.at(-1)).includes('browser_type):\\n[0] button \\"Go\\"'),'the model should see numbered elements');
  // Clicking asks once per chat outside bypass mode.
  await page.locator('#permission').selectOption('read');
  await expect(page.locator('#toast')).toContainText('Permissions updated');
  provider.tool('browser_click',{element:0});
  await page.locator('#prompt').fill('Click Go.');await page.locator('#send').click();
  await expect(page.locator('#approval-dialog')).toBeVisible({timeout:15000});
  await expect(page.locator('#approval-title')).toContainText('Allow browser actions?');
  await page.locator('#allow').click();
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
  assert.deepEqual(webRequests.at(-1),{kind:'browser-click',input:{element:0}});
  provider.tool('browser_type',{element:0,text:'thinkpad',submit:true});
  await send('Type a search.');
  assert.deepEqual(webRequests.at(-1),{kind:'browser-type',input:{element:0,text:'thinkpad',submit:true}});
  provider.tool('browser_screenshot',{});
  await send('Take a screenshot.');
  assert.equal(webRequests.at(-1).kind,'browser-screenshot');
  assert.match(JSON.stringify(provider.requests.at(-1)),/ZmFrZS1qcGVn/);
  // The screenshot appears in the chat, not as an empty result box.
  await expect(page.locator('#messages .tool .tool-image').last()).toHaveAttribute('src','data:image/jpeg;base64,ZmFrZS1qcGVn');
  for(const name of ['browser_click','browser_type','browser_press','browser_scroll','browser_screenshot'])assert.ok(declared(provider.requests.at(-1)).includes(name),name+' should be offered');
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
