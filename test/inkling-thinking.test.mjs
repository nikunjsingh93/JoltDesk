import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocket} from 'ws';
import path from 'node:path';
import {discoverLocal} from '../connections.mjs';
import {startServer} from '../server.mjs';

export async function inklingFixture(){
  const requests=[];
  const http=createServer(async(req,res)=>{
    if(req.method==='GET'){
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(req.url.includes('/models')?{data:[{id:'Inkling-2-Mini-Q4_K_M.gguf',context_length:32768},{id:'other-model'}]}:{}));return;
    }
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    res.setHeader('Content-Type','text/event-stream');
    for(const [delta,finish_reason] of [[{role:'assistant'},null],[{content:'Ready.'},null],[{},'stop']])res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  return {url:'http://127.0.0.1:'+http.address().port,requests,close:()=>http.close()};
}

if(process.env.BOLT_FIXTURE_ONLY!=='1'){
  test('Inkling advertises its effort levels without changing other models or explicit disable',async()=>{
    const fixture=await inklingFixture();try{
      const result=await discoverLocal({baseUrl:fixture.url+'/v1'},'');const [model,other]=result.definition.models;
      assert.deepEqual(Object.keys(model.thinkingLevelMap),['off','minimal','low','medium','high','xhigh','max']);
      assert.equal(model.thinkingOffLabel,'Thinking · None');assert.equal(other.reasoning,false);
      for(const level of Object.keys(model.thinkingLevelMap))assert.deepEqual(model.samplingParamsByThinkingLevel[level],{chat_template_kwargs:{reasoning_effort:level==='off'?'none':level}});
      assert.equal((await discoverLocal({baseUrl:fixture.url+'/v1',thinking:'off'},'')).definition.models[0].reasoning,false);
    }finally{fixture.close();}
  });
  test('Pi-Bolt sends the selected Inkling effort in the template kwargs',async()=>{
    const fixture=await inklingFixture(),dir=path.resolve('work/inkling-thinking-'+Date.now());let server,ws;
    try{
      server=await startServer({dataDir:dir,autoStartUpdates:false});
      const api=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(server.url+'/api'+route,{method,headers:{'X-Bolt-Token':server.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const p=await r.json();assert.equal(r.status,200,JSON.stringify(p));return p;};
      await api('/connect',{provider:'local',name:'Fixture',baseUrl:fixture.url+'/v1',maxTokens:'auto'});const chat=await api('/chats',{});const events=[];
      ws=new WebSocket(server.url.replace('http','ws')+`/stream?chat=${chat.id}&token=${server.token}`);ws.on('message',d=>events.push(JSON.parse(d)));await new Promise(r=>ws.once('open',r));
      for(const level of ['off','minimal','low','medium','high','xhigh','max']){
        await api('/chats/'+chat.id,{model:'Inkling-2-Mini-Q4_K_M.gguf',thinking:level},'PATCH');events.length=0;ws.send(JSON.stringify({type:'prompt',message:'Reply briefly.'}));
        const until=Date.now()+15000;while(!events.some(e=>e.type==='agent_settled')){const error=events.find(e=>e.type==='app_error');if(error)throw new Error(error.message);if(Date.now()>until)throw new Error('Reply timed out');await new Promise(r=>setTimeout(r,20));}
        const body=fixture.requests.at(-1);assert.equal(body.chat_template_kwargs?.reasoning_effort,level==='off'?'none':level);assert.equal(body.reasoning_effort,undefined);
      }
    }finally{ws?.close();server?.close();fixture.close();}
  });
}
