import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {startServer} from '../server.mjs';

process.env.GIT_CEILING_DIRECTORIES=path.resolve('work');
const dir=path.resolve('work/worker-progress-ui-'+Date.now()),requests=[];
const provider=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:['lead','worker-a','worker-b'].map(id=>({id,context_length:8192}))}));}
  if(!req.url.endsWith('/chat/completions')){res.statusCode=404;return res.end('{}');}
  const body=JSON.parse(raw),model=body.model;requests.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=data=>res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:1,model,...data})+'\n\n');
  if(model==='lead'&&!body.messages.some(m=>m.role==='tool')){
    send({choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_workers',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({mode:'questions',tasks:['Analyze option A','Analyze option B']})}}]}}]});
    send({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});
  }else{
    const chunks=model==='lead'?['Lead reviewed the answers.']:Array.from({length:20},(_,i)=>`${model} part ${i+1}. `);
    for(const text of chunks){send({choices:[{index:0,delta:{role:'assistant',content:text}}]});if(model!=='lead')await new Promise(r=>setTimeout(r,180));}
    send({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:44,total_tokens:64}});
  }
  res.end('data: [DONE]\n\n');
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));await fs.mkdir(dir,{recursive:true});
const server=await startServer({dataDir:dir,autoStartUpdates:false});
const api=async(url,body,method)=>{const r=await fetch(server.url+'/api'+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
const env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
  const config=await api('/connect',{provider:'local',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,profile:'generic',name:'Fixture',key:'',maxTokens:'auto'});
  const chat=await api('/chats',{model:'lead'});await api('/chats/'+chat.id,{workerSlots:[{connectionId:config.connection.id,model:'worker-a'},{connectionId:config.connection.id,model:'worker-b'}]},'PATCH');
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});const page=await app.firstWindow();
  await page.locator('.open-chat[data-id="'+chat.id+'"]').click();await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await page.locator('#prompt').fill('Ask the workers to compare options.');await page.locator('#send').click();
  await expect(page.locator('#worker-progress .worker-progress-row')).toHaveCount(2,{timeout:20000});
  await expect(page.locator('#worker-progress')).toContainText('worker-a');await expect(page.locator('#worker-progress')).toContainText('worker-b');
  await expect(page.locator('#worker-progress')).toContainText('Analyze option A');
  await expect(page.locator('#worker-progress .worker-progress-state').first()).toContainText('tokens',{timeout:20000});
  await expect(page.locator('#worker-progress .worker-progress-preview').first()).toContainText('worker-a');
  await page.screenshot({path:'work/screenshots/worker-progress.png'});
  await page.reload();await page.locator('.open-chat[data-id="'+chat.id+'"]').click();
  await expect(page.locator('#worker-progress .worker-progress-row')).toHaveCount(2,{timeout:20000});
  await expect(page.locator('#worker-progress')).toContainText('worker-a');
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:20000});
  await expect(page.locator('#worker-progress .worker-progress-state').first()).toContainText('Finished');
  await expect(page.locator('#worker-progress .worker-progress-state').first()).toContainText('44 tokens');
  assert.ok(requests.some(r=>r.model==='worker-a')&&requests.some(r=>r.model==='worker-b'));
  console.log('WORKER PROGRESS UI PASS: parallel status, live preview and token count, reload recovery, and final exact count.');
}finally{await app?.close();server.close();provider.close();}
