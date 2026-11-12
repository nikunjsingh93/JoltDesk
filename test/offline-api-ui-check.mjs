// A chat whose API is offline still opens, shows its history, and can move to a working API.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { mockProvider, testModel } from './mock-provider.mjs';

// A minimal OpenAI-compatible local server that can be stopped mid-test.
const local=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'unsloth-model'}]}));return;}
  if(req.url.endsWith('/chat/completions')){
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const chunk=data=>res.write('data: '+JSON.stringify({id:'c1',object:'chat.completion.chunk',created:1,model:'unsloth-model',choices:[{index:0,...data}]})+'\n\n');
    chunk({delta:{role:'assistant',content:'Hello from Unsloth'}});
    chunk({delta:{},finish_reason:'stop'});
    res.end('data: [DONE]\n\n');return;
  }
  res.statusCode=404;res.end('{}');
});
await new Promise(r=>local.listen(0,'127.0.0.1',r));
const localUrl=`http://127.0.0.1:${local.address().port}/v1`;

const dir=path.resolve('work/offline-api-'+Date.now());
const provider=await mockProvider();
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
const original=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'
  ?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
const server=await startServer({dataDir:dir,autoStartUpdates:false});
const env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});
  const page=await app.firstWindow();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const call=async(url,body,method)=>{const r=await original(server.url+'/api'+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
  await call('/connect',{provider:'openai',key:'sk-fake',remember:false,name:'OpenAI'});
  let config=await call('/connect',{provider:'local',baseUrl:localUrl,profile:'generic',name:'Unsloth',key:'',maxTokens:'auto'});
  const unsloth=config.connections.find(c=>c.name==='Unsloth'),openai=config.connections.find(c=>c.name==='OpenAI');
  await page.reload();
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await page.locator('#prompt').fill('Hi Unsloth');await page.locator('#send').click();
  await expect(page.locator('#messages')).toContainText('Hello from Unsloth',{timeout:20000});
  await expect(page.locator('#send')).not.toHaveClass(/running/);
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await page.locator('#prompt').fill('Second on Unsloth');await page.locator('#send').click();
  await expect(page.locator('#messages')).toContainText('Hello from Unsloth',{timeout:20000});
  await expect(page.locator('#send')).not.toHaveClass(/running/);

  // Use the other API, then the Unsloth server goes away.
  await call(`/connections/${openai.id}/activate`,{});
  await new Promise(r=>local.close(r));local.closeAllConnections?.();
  await page.reload();
  await page.locator('.open-chat',{hasText:'Hi Unsloth'}).click();
  await expect(page.locator('#messages')).toContainText('Hello from Unsloth');
  await expect(page.locator('#toast')).toContainText('Unsloth is not reachable');
  await expect(page.locator('#status')).toHaveText('Unsloth offline');
  assert.equal(await page.locator('#model').inputValue(),unsloth.id+'::unsloth-model');

  // Continue the same chat on the working API.
  const before=provider.requests.length;
  await page.locator('#model').selectOption('bolt-test');
  await page.locator('#prompt').fill('Continue with OpenAI');await page.locator('#send').click();
  await expect.poll(()=>provider.requests.length).toBeGreaterThan(before);
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:20000});
  await expect(page.locator('#messages')).toContainText('Your workspace is ready.');
  await expect(page.locator('#messages')).toContainText('Hello from Unsloth');
  assert.match(JSON.stringify(provider.requests.at(-1)),/Hi Unsloth/);

  // After its API is removed, a chat still opens from its saved session and can continue elsewhere.
  await call('/connections/'+unsloth.id,{},'DELETE');
  await page.reload();
  await page.locator('.open-chat',{hasText:'Second on Unsloth'}).click();
  await expect(page.locator('#messages')).toContainText('Second on Unsloth');
  await expect(page.locator('#messages')).toContainText('Hello from Unsloth');
  await expect(page.locator('#status')).toHaveText('API removed');
  await expect(page.locator('#toast')).toContainText('API was removed');
  const history=await call('/chats/'+(await call('/config')).chats.find(c=>c.title==='Second on Unsloth').id+'/history');
  assert.equal(history.offline.kind,'engine');
  assert.deepEqual(history.messages.map(m=>m.role),['user','assistant']);
  const later=provider.requests.length;
  await page.locator('#model').selectOption('bolt-test');
  await page.locator('#prompt').fill('Moving to OpenAI');await page.locator('#send').click();
  await expect.poll(()=>provider.requests.length).toBeGreaterThan(later);
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:20000});
  assert.match(JSON.stringify(provider.requests.at(-1)),/Second on Unsloth/);
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('OFFLINE API UI PASS: chat with an offline API opens with history and a notice, shows its own model, continues on another API, and a chat whose API was removed opens from its saved session and continues elsewhere.');
}finally{
  await app?.close();
  server.close();
  provider.close();
  local.close();
  globalThis.fetch=original;
}
