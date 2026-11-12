// Prompt-processing progress and the Unsloth Studio context limit appear while a prompt is processing.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';

const requests=[];let loaded=false;
const studio=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const url=new URL(req.url,'http://x');
  const json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
  if(url.pathname==='/v1/models')return json({data:[{id:'ornith-test',owned_by:'unsloth-studio'}]});
  // Like Studio: the status names the model only once it is loaded for a request.
  if(url.pathname==='/v1/status')return json(loaded?{model_identifier:'ornith-test',active_model:'ornith-test',context_length:128640,is_vision:true}:{model_identifier:null,context_length:null});
  if(url.pathname==='/v1/chat/completions'){
    requests.push(JSON.parse(raw));loaded=true;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=data=>res.write('data: '+JSON.stringify({id:'c1',object:'chat.completion.chunk',created:1,model:'ornith-test',...data})+'\n\n');
    send({choices:[],prompt_progress:{total:1000,cache:120,processed:430,time_ms:900}});
    await new Promise(r=>setTimeout(r,4500));
    send({choices:[],prompt_progress:{total:1000,cache:120,processed:1000,time_ms:2100}});
    send({choices:[{index:0,delta:{role:'assistant',content:'Prompt processed.'}}]});
    send({choices:[{index:0,delta:{},finish_reason:'stop'}]});
    return res.end('data: [DONE]\n\n');
  }
  res.statusCode=404;json({detail:'Not found'});
});
await new Promise(r=>studio.listen(0,'127.0.0.1',r));

const dir=path.resolve('work/prompt-progress-'+Date.now());
await fs.mkdir(dir,{recursive:true});
const server=await startServer({dataDir:dir,autoStartUpdates:false});
const env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};
delete env.ELECTRON_RUN_AS_NODE;
const call=async(url,body)=>{const r=await fetch(server.url+'/api'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
let app;
try{
  const config=await call('/connect',{provider:'local',baseUrl:`http://127.0.0.1:${studio.address().port}/v1`,profile:'llamacpp',name:'Studio',key:'',maxTokens:'auto'});
  assert.equal(config.models[0].contextWindowEstimated,true);
  const {version}=JSON.parse(await fs.readFile('package.json','utf8'));
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});
  const page=await app.firstWindow();
  await expect(page.locator('#app-version')).toHaveText('v'+version);
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  // No guessed limit before the server reports one.
  await expect(page.locator('#context')).not.toContainText('/');
  await page.locator('#prompt').fill('A long prompt');await page.locator('#send').click();
  await expect(page.locator('#activity-text')).toHaveText('Processing prompt · 43% (430 / 1,000 tokens, 120 cached)',{timeout:15000});
  // While the prompt is read, the meter shows the server's prompt size rather than zero,
  // and the real limit appears before the reply.
  await expect(page.locator('#context')).toContainText('Context 1,000');
  await expect(page.locator('#context')).toContainText('/ 128,640',{timeout:4000});
  await expect(page.locator('#messages')).toContainText('Prompt processed.',{timeout:15000});
  assert.equal(requests[0].return_progress,true);
  const saved=(await call('/config')).models[0];
  assert.deepEqual({window:saved.contextWindow,estimated:saved.contextWindowEstimated,input:saved.input},{window:128640,estimated:false,input:['text','image']});
  console.log('PROMPT PROGRESS UI PASS: version label, no guessed limit, live prompt-processing percent, Unsloth context limit and vision confirmed during processing.');
}finally{
  await app?.close();
  server.close();
  studio.close();
}
