import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import {startServer} from '../server.mjs';

async function fixture(kind){
  const requests=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:kind,context_length:8192}]}));}
    if(!req.url.endsWith('/chat/completions')){res.statusCode=404;return res.end('{}');}
    const body=JSON.parse(raw);requests.push(body);
    const hasResult=body.messages.some(m=>m.role==='tool');
    let tool=null;
    if(!hasResult){
      const delegate=body.tools?.find(t=>(t.function?.name||t.name)==='delegate_tasks');
      if(kind==='lead'&&delegate){const description=delegate.function?.description||delegate.description;const text=JSON.stringify(body.messages);const questions=text.includes('parallel questions');const prohibited=text.includes('try coding without permission');tool={name:'delegate_tasks',args:{mode:questions?'questions':'coding',tasks:questions?['What is the first answer?','What is the second answer?']:prohibited?['Write worker one file']:description.includes('worker-a')?['Write worker one file','Write worker two file']:['Write worker two file']}};}
      else if(kind!=='lead'&&(body.tools||[]).some(t=>(t.function?.name||t.name)==='write'))tool={name:'write',args:{path:kind+'.txt',content:'from '+kind}};
    }
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=data=>res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:1,model:kind,...data})+'\n\n');
    if(tool){send({choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_'+kind,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}}]});send({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});}
    else{send({choices:[{index:0,delta:{role:'assistant',content:kind+' finished'}}]});send({choices:[{index:0,delta:{},finish_reason:'stop'}]});}
    res.end('data: [DONE]\n\n');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,close:()=>server.close()};
}
test('lead delegates to two independent worker connections and isolated worktrees',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jolt-team-'));
  const repo=path.join(dir,'project');await fs.mkdir(repo);const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe',windowsHide:true});git('init');git('config','user.name','Test');git('config','user.email','test@example.invalid');await fs.writeFile(path.join(repo,'base.txt'),'base');git('add','.');git('commit','-m','base');
  const [lead,a,b]=await Promise.all(['lead','worker-a','worker-b'].map(fixture));
  const server=await startServer({dataDir:path.join(dir,'data'),autoStartUpdates:false});
  const api=async(url,body,method)=>{const r=await fetch(server.url+'/api'+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
  const connections=[];for(const f of [lead,a,b]){const c=await api('/connect',{provider:'local',baseUrl:f.url,profile:'generic',name:'Fixture',key:'',maxTokens:'auto'});connections.push(c.connection.id);}
  await api('/connections/'+connections[0]+'/activate',{});
  const project=await api('/projects',{path:repo,name:'Project'});const chat=await api('/chats',{projectId:project.id,model:'lead'});
  await api('/chats/'+chat.id,{mode:'ask',workerSlots:[{connectionId:connections[1],model:'worker-a'},{connectionId:connections[2],model:'worker-b'}]},'PATCH');
  const ws=new WebSocket(server.url.replace('http','ws')+'/stream?chat='+chat.id+'&token='+server.token);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
  t.after(async()=>{ws.terminate();server.close();[lead,a,b].forEach(f=>f.close());await new Promise(r=>setTimeout(r,2000));await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:500});});
  const events=[];const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out: '+JSON.stringify(events.slice(-8)))),45000);ws.on('message',raw=>{const e=JSON.parse(raw);events.push(e);if(e.type==='extension_ui_request'&&e.method==='confirm')ws.send(JSON.stringify({type:'ui_response',id:e.id,confirmed:true}));if(e.type==='app_error'){clearTimeout(timer);reject(new Error(e.message));}if(e.type==='agent_settled'){clearTimeout(timer);resolve();}})});
  ws.send(JSON.stringify({type:'prompt',message:'Delegate these independent tasks.'}));await done;
  assert.equal(events.filter(e=>e.type==='extension_ui_request'&&e.method==='confirm').length,2);
  const delegated=lead.requests[0].tools.find(t=>(t.function?.name||t.name)==='delegate_tasks');assert.ok(delegated);assert.match(delegated.function?.description||delegated.description,/worker-a/);assert.match(delegated.function?.description||delegated.description,/worker-b/);
  assert.ok(a.requests.length>=2&&b.requests.length>=2);assert.ok(events.some(e=>e.type==='worker_status'&&e.index===0&&e.state==='done'));assert.ok(events.some(e=>e.type==='worker_status'&&e.index===1&&e.state==='done'));
  assert.equal(await fs.readdir(repo).then(v=>v.includes('worker-a.txt')),false);
  const reports=await api('/chats/'+chat.id+'/workers');assert.equal(reports.length,1);assert.equal(reports[0].results.length,2);assert.ok(reports[0].results.every(r=>r.worktree&&r.changes.status));
  const dirs=await fs.readdir(path.join(dir,'data','workers','worktrees'));assert.equal(dirs.length,2);
  const contents=await Promise.all(dirs.map(d=>fs.readdir(path.join(dir,'data','workers','worktrees',d))));assert.ok(contents.some(c=>c.includes('worker-a.txt')));assert.ok(contents.some(c=>c.includes('worker-b.txt')));
  // An unchecked slot stays configured but is not offered or invoked.
  const counts={a:a.requests.length,b:b.requests.length};
  const chat2=await api('/chats',{projectId:project.id,model:'lead'});
  const saved=await api('/chats/'+chat2.id,{mode:'ask',workerSlots:[{connectionId:connections[1],model:'worker-a',enabled:false},{connectionId:connections[2],model:'worker-b',enabled:true}]},'PATCH');
  assert.deepEqual(saved.workerSlots.map(s=>s.enabled),[false,true]);
  const ws2=new WebSocket(server.url.replace('http','ws')+'/stream?chat='+chat2.id+'&token='+server.token);t.after(()=>ws2.terminate());await new Promise((r,j)=>{ws2.once('open',r);ws2.once('error',j)});
  const events2=[];const done2=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out second chat')),45000);ws2.on('message',raw=>{const e=JSON.parse(raw);events2.push(e);if(e.type==='extension_ui_request'&&e.method==='confirm')ws2.send(JSON.stringify({type:'ui_response',id:e.id,confirmed:true}));if(e.type==='app_error'){clearTimeout(timer);reject(new Error(e.message));}if(e.type==='agent_settled'){clearTimeout(timer);resolve();}})});
  ws2.send(JSON.stringify({type:'prompt',message:'Delegate the task.'}));await done2;
  const second=lead.requests.findLast(r=>r.tools?.some(t=>(t.function?.name||t.name)==='delegate_tasks'));
  const desc=second.tools.find(t=>(t.function?.name||t.name)==='delegate_tasks').function.description;
  assert.doesNotMatch(desc,/worker-a/);assert.match(desc,/worker-b/);
  assert.equal(a.requests.length,counts.a);assert.ok(b.requests.length>counts.b);
  assert.ok(events2.some(e=>e.type==='worker_status'&&e.index===1&&e.state==='done'));
  const chat3=await api('/chats',{projectId:project.id,model:'lead'});
  await api('/chats/'+chat3.id,{mode:'ask',workerSlots:[{connectionId:connections[1],model:'worker-a',enabled:false}]},'PATCH');
  const before={a:a.requests.length,b:b.requests.length};
  const ws3=new WebSocket(server.url.replace('http','ws')+'/stream?chat='+chat3.id+'&token='+server.token);t.after(()=>ws3.terminate());await new Promise((r,j)=>{ws3.once('open',r);ws3.once('error',j)});
  const done3=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out disabled chat')),45000);ws3.on('message',raw=>{const e=JSON.parse(raw);if(e.type==='app_error'){clearTimeout(timer);reject(new Error(e.message));}if(e.type==='agent_settled'){clearTimeout(timer);resolve();}})});
  ws3.send(JSON.stringify({type:'prompt',message:'Do not use workers.'}));await done3;
  assert.ok(!(lead.requests.at(-1).tools||[]).some(t=>(t.function?.name||t.name)==='delegate_tasks'));
  assert.equal(a.requests.length,before.a);assert.equal(b.requests.length,before.b);
  // Changing a previously used chat must replace its runner and remove the tool.
  await api('/chats/'+chat.id,{workerSlots:[{connectionId:connections[1],model:'worker-a',enabled:false},{connectionId:connections[2],model:'worker-b',enabled:false}]},'PATCH');
  const beforeResume={a:a.requests.length,b:b.requests.length,lead:lead.requests.length};
  const resumed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out after disabling workers')),45000);const handler=raw=>{const e=JSON.parse(raw);if(e.type==='app_error'){clearTimeout(timer);ws.off('message',handler);reject(new Error(e.message));}if(e.type==='agent_settled'){clearTimeout(timer);ws.off('message',handler);resolve();}};ws.on('message',handler);});
  ws.send(JSON.stringify({type:'prompt',message:'Workers are off.'}));await resumed;
  assert.ok(lead.requests.length>beforeResume.lead);assert.ok(!(lead.requests.at(-1).tools||[]).some(t=>(t.function?.name||t.name)==='delegate_tasks'));
  assert.equal(a.requests.length,beforeResume.a);assert.equal(b.requests.length,beforeResume.b);
  // General chats can ask workers independently without Git or file tools.
  const general=await api('/chats',{model:'lead'});
  await api('/chats/'+general.id,{workerSlots:[{connectionId:connections[1],model:'worker-a'},{connectionId:connections[2],model:'worker-b'}]},'PATCH');
  const beforeQuestions={a:a.requests.length,b:b.requests.length,dirs:(await fs.readdir(path.join(dir,'data','workers','worktrees'))).length};
  const ws4=new WebSocket(server.url.replace('http','ws')+'/stream?chat='+general.id+'&token='+server.token);t.after(()=>ws4.terminate());await new Promise((r,j)=>{ws4.once('open',r);ws4.once('error',j)});
  const events4=[];const done4=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out question workers')),45000);ws4.on('message',raw=>{const e=JSON.parse(raw);events4.push(e);if(e.type==='app_error'){clearTimeout(timer);reject(new Error(e.message));}if(e.type==='agent_settled'){clearTimeout(timer);resolve();}})});
  ws4.send(JSON.stringify({type:'prompt',message:'Ask parallel questions.'}));await done4;
  assert.ok(a.requests.length>beforeQuestions.a&&b.requests.length>beforeQuestions.b);
  for(const request of [a.requests.at(-1),b.requests.at(-1)])assert.equal((request.tools||[]).length,0);
  assert.equal((await fs.readdir(path.join(dir,'data','workers','worktrees'))).length,beforeQuestions.dirs);
  const questionReports=await api('/chats/'+general.id+'/workers');assert.equal(questionReports[0].results.length,2);assert.ok(questionReports[0].results.every(r=>r.mode==='questions'&&r.answer&&!r.worktree));
  assert.ok(events4.some(e=>e.type==='worker_status'&&e.index===0&&e.state==='done'));
  assert.ok(events4.some(e=>e.type==='worker_status'&&e.index===0&&e.tokens>0&&e.preview));
  assert.ok(events4.some(e=>e.type==='worker_status'&&e.index===1&&e.tokens>0&&e.preview));
  const liveHistory=await api('/chats/'+general.id+'/history');assert.equal(liveHistory.workerProgress[0].state,'done');assert.ok(liveHistory.workerProgress[0].tokens>0);
  // The lead cannot run coding workers from a Chat-only general conversation.
  const blocked=await api('/chats',{model:'lead'});await api('/chats/'+blocked.id,{workerSlots:[{connectionId:connections[1],model:'worker-a'}]},'PATCH');
  const countBefore=a.requests.length,ws5=new WebSocket(server.url.replace('http','ws')+'/stream?chat='+blocked.id+'&token='+server.token);t.after(()=>ws5.terminate());await new Promise((r,j)=>{ws5.once('open',r);ws5.once('error',j)});
  const done5=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out blocked coding')),45000);ws5.on('message',raw=>{const e=JSON.parse(raw);if(e.type==='app_error'){clearTimeout(timer);reject(new Error(e.message));}if(e.type==='agent_settled'){clearTimeout(timer);resolve();}})});
  ws5.send(JSON.stringify({type:'prompt',message:'try coding without permission'}));await done5;
  assert.equal(a.requests.length,countBefore);assert.match(JSON.stringify(lead.requests.at(-1).messages),/Coding workers require Ask/);


});
