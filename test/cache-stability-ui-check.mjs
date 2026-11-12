// Local models: toggling Web or permissions keeps the prompt prefix identical, disabled
// tools stay blocked, and switching a long chat to another local model warns first.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';

const requests=[];let nextTool=null;
const local=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'model-a'},{id:'model-b'}]}));}
  if(!req.url.endsWith('/chat/completions')){res.statusCode=404;return res.end('{}');}
  const body=JSON.parse(raw);requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=data=>res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:1,model:body.model,...data})+'\n\n');
  if(nextTool){
    const tool=nextTool;nextTool=null;
    send({choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_'+requests.length,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}}]});
    send({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});
  }else{
    send({choices:[{index:0,delta:{role:'assistant',content:'OK'}}]});
    send({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:32421,completion_tokens:1,total_tokens:32422},timings:{prompt_n:32421,prompt_ms:876000,prompt_per_second:37,predicted_n:1,predicted_ms:30,predicted_per_second:33}});
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(r=>local.listen(0,'127.0.0.1',r));
const dir=path.resolve('work/cache-stability-'+Date.now());
await fs.mkdir(dir,{recursive:true});
const server=await startServer({dataDir:dir,autoStartUpdates:false,native:{fileAction:async()=>{},webTools:async()=>({sources:[]})}});
const env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};
delete env.ELECTRON_RUN_AS_NODE;
const call=async(url,body)=>{const r=await fetch(server.url+'/api'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
const toolNames=body=>JSON.stringify((body.tools||[]).map(t=>t.function?.name||t.name));
const systemText=body=>JSON.stringify(body.messages.filter(m=>m.role==='system'||m.role==='developer'));
const tail=body=>JSON.stringify(body.messages.at(-1).content);
let app;
try{
  await call('/connect',{provider:'local',baseUrl:`http://127.0.0.1:${local.address().port}/v1`,profile:'llamacpp',name:'Laptop',key:'',maxTokens:'auto'});
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});
  const page=await app.firstWindow();
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  const send=async text=>{
    const before=requests.length;
    await page.locator('#prompt').fill(text);await page.locator('#send').click();
    await expect.poll(()=>requests.length).toBeGreaterThan(before);
    await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:20000});
  };
  await send('First message in chat-only mode.');
  const first=requests.at(-1);
  assert.match(tail(first),/bolt_permission_state.*chat/);
  assert.ok(JSON.parse(toolNames(first)).includes('write'),'local models always declare the full tool set');

  await page.locator('#web-tools').check();
  await send('Now with Web on.');
  await page.locator('#permission').selectOption('read');
  await expect(page.locator('#toast')).toContainText('Permissions updated');
  await send('Now in Read files mode.');
  const [a,b,c]=requests.slice(-3);
  assert.equal(toolNames(b),toolNames(a));assert.equal(toolNames(c),toolNames(a));
  assert.equal(systemText(b),systemText(a));assert.equal(systemText(c),systemText(a));
  // Earlier messages are sent unchanged, so the server can reuse its cache for them.
  assert.equal(JSON.stringify(c.messages.slice(0,b.messages.length-1)),JSON.stringify(b.messages.slice(0,b.messages.length-1)));
  assert.match(tail(c),/read/);assert.doesNotMatch(tail(a),/web_search, /);

  // A tool outside the current permissions is blocked, with a reason the model can use.
  nextTool={name:'write',args:{path:'blocked.txt',content:'x'}};
  await send('Try to write a file.');
  const toolResult=requests.at(-1).messages.find(m=>m.role==='tool');
  assert.match(JSON.stringify(toolResult.content),/not allowed right now/);
  await assert.rejects(fs.stat(path.join(dir,'workspace','blocked.txt')));

  // Switching this ~32K-token chat to another local model warns first.
  await page.evaluate(()=>{const option=[...document.querySelectorAll('#model option')].find(o=>o.dataset.modelId==='model-b');localStorage.setItem('joltdesk-prefill:'+option.dataset.connectionId+'::model-b','37');});
  const chosen=await page.locator('#model').inputValue();
  const optionB=await page.evaluate(()=>[...document.querySelectorAll('#model option')].find(o=>o.dataset.modelId==='model-b').value);
  await page.locator('#model').selectOption(optionB);
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await expect(page.locator('#confirm-message')).toContainText('about 32K tokens');
  await expect(page.locator('#confirm-message')).toContainText('about 15 minutes');
  await page.locator('#confirm-cancel').click();
  await expect(page.locator('#model')).toHaveValue(chosen);
  await page.locator('#model').selectOption(optionB);
  await page.locator('#confirm-ok').click();
  await expect.poll(async()=>(await call('/config')).chats[0].model).toBe('model-b');
  console.log('CACHE STABILITY UI PASS: identical tools and system prompt across Web and permission changes, permission note at the tail, disabled tools blocked, model-switch warning with measured time, cancel and confirm.');
}finally{
  await app?.close();
  server.close();
  local.close();
}
