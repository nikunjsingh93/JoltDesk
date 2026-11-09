import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startServer} from '../server.mjs';
import {mockProvider,testModel} from './mock-provider.mjs';

test('real Pi-Bolt: streaming, usage, attachments, approvals, bypass, persistence and local API protection',async()=>{
  const dir=path.resolve('work/integration-'+Date.now()),provider=await mockProvider();
  await fs.mkdir(path.join(dir,'agent'),{recursive:true});
  await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'?Promise.resolve(new Response(JSON.stringify({data:[{id:'bolt-test'}]}),{headers:{'Content-Type':'application/json'}})):originalFetch(url,options);
  let server,ws;
  try{
    server=await startServer({dataDir:dir,autoStartUpdates:false});
    const api=async(route,body,method=body?'POST':'GET')=>{const r=await originalFetch(server.url+'/api'+route,{method,headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
    assert.equal((await originalFetch(server.url+'/api/config')).status,403);
    assert.equal((await originalFetch(server.url+'/api/config',{headers:{Origin:'https://untrusted.example','X-Bolt-Token':server.token}})).status,403);
    const connected=await api('/connect',{key:'sk-test-not-real',remember:false});assert.deepEqual(connected.models.map(m=>m.id),['bolt-test']);
    const chat=await api('/chats',{});await api('/chats/'+chat.id,{model:'bolt-test',thinking:'medium'},'PATCH');
    const events=[];ws=new WebSocket(server.url.replace('http','ws')+`/stream?chat=${chat.id}&token=${server.token}`);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
    ws.on('message',d=>events.push(JSON.parse(d)));
    const wait=async(type,predicate=()=>true)=>{const until=Date.now()+20000;while(Date.now()<until){const found=events.find(e=>e.type===type&&predicate(e));if(found)return found;const error=events.find(e=>e.type==='app_error');if(error)throw new Error(error.message);await new Promise(r=>setTimeout(r,30));}throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(events).slice(-4000)}`);};
    ws.send(JSON.stringify({type:'prompt',message:'Make an example',files:[{name:'note.txt',type:'text/plain',data:Buffer.from('Attachment content sentinel').toString('base64')}]}));
    if(connected.engine){
      await wait('message_update');
      const busy=await originalFetch(server.url+'/api/engine/install',{method:'POST',headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:'{}'});
      assert.equal(busy.status,400);assert.match((await busy.json()).error,/active chats/);
    }
    await wait('agent_settled');await wait('stats');
    assert.ok(events.some(e=>e.assistantMessageEvent?.type==='thinking_delta'));
    assert.ok(events.some(e=>e.assistantMessageEvent?.type==='text_delta'));
    assert.ok(events.find(e=>e.type==='stats').data.tokens.output>0);
    assert.ok(JSON.stringify(provider.requests[0]).includes('Attachment content sentinel'));
    const history=await api(`/chats/${chat.id}/history`);assert.ok(history.messages.some(m=>m.role==='assistant'));assert.ok(history.stats.contextUsage.tokens>0);
    events.length=0;
    await api('/chats/'+chat.id,{mode:'ask'},'PATCH');provider.tool('write',{path:'approved.txt',content:'created by approved tool'});
    ws.send(JSON.stringify({type:'prompt',message:'Write a file'}));
    const request=await wait('extension_ui_request',e=>e.method==='confirm');
    await assert.rejects(fs.stat(path.join(dir,'workspace','approved.txt')));
    ws.send(JSON.stringify({type:'ui_response',id:request.id,confirmed:false,cancelled:true}));await wait('agent_settled');
    await assert.rejects(fs.stat(path.join(dir,'workspace','approved.txt')));
    events.length=0;provider.tool('write',{path:'approved.txt',content:'created by approved tool'});
    ws.send(JSON.stringify({type:'prompt',message:'Try writing with my approval'}));
    const approved=await wait('extension_ui_request',e=>e.method==='confirm');ws.send(JSON.stringify({type:'ui_response',id:approved.id,confirmed:true}));await wait('agent_settled');
    assert.equal(await fs.readFile(path.join(dir,'workspace','approved.txt'),'utf8'),'created by approved tool');
    events.length=0;await api('/chats/'+chat.id,{mode:'bypass'},'PATCH');provider.tool('write',{path:'bypass.txt',content:'bypass worked'});
    ws.send(JSON.stringify({type:'prompt',message:'Write in bypass mode'}));await wait('agent_settled');assert.ok(!events.some(e=>e.type==='extension_ui_request'&&e.method==='confirm'));
    assert.equal(await fs.readFile(path.join(dir,'workspace','bypass.txt'),'utf8'),'bypass worked');
    ws.close();server.close();server=await startServer({dataDir:dir,autoStartUpdates:false});
    const restored=await api(`/chats/${chat.id}/history`);assert.ok(restored.messages.length>history.messages.length);
    const stored=await fs.readFile(path.join(dir,'workspace.json'),'utf8');assert.ok(!stored.includes('sk-test-not-real'));
  }finally{ws?.close();server?.close();provider.close();globalThis.fetch=originalFetch;}
});
