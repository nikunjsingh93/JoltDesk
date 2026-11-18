import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startServer} from '../server.mjs';

// A minimal OpenAI-compatible server that records each chat request body.
async function mock(owner){
  const bodies=[];
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){
      if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'mock-model',owned_by:owner}]}));
      else{res.statusCode=404;res.end('{}');}return;
    }
    let raw='';for await(const c of req)raw+=c;bodies.push(JSON.parse(raw));
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:1,model:'mock-model',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    send({role:'assistant'});send({content:'Hello.'});send({},'stop');
    res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',model:'mock-model',choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\n');res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}/v1`,bodies,close:()=>server.close()};
}

async function requestBody(owner){
  const fixture=await mock(owner),dir=path.resolve('work/torc-output-'+owner+'-'+Date.now());
  let encrypted='',server,ws;const vault={get:async()=>encrypted,set:async k=>{encrypted=k;},clear:async()=>{encrypted='';}};
  const events=[];
  try{
    server=await startServer({dataDir:dir,vault,autoStartUpdates:false});
    const api=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(server.url+'/api'+route,{method,headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
    const config=await api('/connect',{provider:'local',baseUrl:fixture.url,remember:true});
    assert.equal(config.models[0].torc,owner==='torc');
    await api('/model',{modelId:'mock-model'});
    const chat=await api('/chats',{});await api('/chats/'+chat.id,{model:'mock-model',thinking:'off'},'PATCH');
    ws=new WebSocket(server.url.replace('http','ws')+`/stream?chat=${chat.id}&token=${server.token}`);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.on('message',d=>events.push(JSON.parse(d)));
    ws.send(JSON.stringify({type:'prompt',message:'Say hello'}));
    const until=Date.now()+25000;while(Date.now()<until&&!events.some(e=>e.type==='agent_settled'))await new Promise(r=>setTimeout(r,20));
    assert.ok(events.some(e=>e.type==='agent_settled'),'chat did not finish');
    return fixture.bodies[0];
  }finally{ws?.close();server?.close();fixture.close();}
}

test('ToRc defaults to 4096 output tokens, so JoltDesk sends the model limit; other servers keep Auto (no max_tokens)',async()=>{
  const torc=await requestBody('torc');
  assert.ok(torc.max_tokens>4096,'ToRc must receive an explicit max_tokens, got '+torc.max_tokens);
  const other=await requestBody('llamacpp');
  assert.equal(other.max_tokens,undefined);
});
