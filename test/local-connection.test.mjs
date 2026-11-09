import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startServer} from '../server.mjs';
import {normalizeBaseUrl} from '../connections.mjs';

export async function localFixture(){
  const requests=[];let required='',nextTool=false;
  const server=createServer(async(req,res)=>{
    const authorization=req.headers.authorization||'';
    if(required&&authorization!==`Bearer ${required}`){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"bad key"}');return;}
    if(req.method==='GET'){
      requests.push({url:req.url,authorization});res.setHeader('Content-Type','application/json');
      if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'qwen-local',name:'Qwen on Mac'}]}));
      else if(req.url==='/props')res.end(JSON.stringify({default_generation_settings:{n_ctx:65536},chat_template:'{% if enable_thinking %}<think>{% endif %}',modalities:{vision:false}}));
      else{res.statusCode=404;res.end('{}');}return;
    }
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({url:req.url,authorization,body});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(delta,finish_reason=null,usage)=>res.write('data: '+JSON.stringify({id:'chatcmpl-local',object:'chat.completion.chunk',created:1,model:'qwen-local',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
    send({role:'assistant'});
    if(nextTool){nextTool=false;send({tool_calls:[{index:0,id:'local-call',type:'function',function:{name:'write',arguments:JSON.stringify({path:'local-tool.txt',content:'Local tool passed'})}}]});send({},'tool_calls');}
    else{
      send({reasoning_content:'Checking the request carefully.'});await new Promise(r=>setTimeout(r,40));
      send({content:'Qwen connection ready.\n\n```javascript\nconst local = true;\n```'});send({},'stop');
    }
    res.write('data: '+JSON.stringify({id:'chatcmpl-local',object:'chat.completion.chunk',model:'qwen-local',choices:[],usage:{prompt_tokens:120,completion_tokens:22,total_tokens:142},timings:{predicted_n:22,predicted_ms:1050,predicted_per_second:20,prompt_ms:6000}})+'\n\n');res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,requireKey:k=>{required=k;},tool:()=>{nextTool=true;},close:()=>server.close()};
}

test('OpenAI-compatible API: discovery, custom limits, streamed thinking, auth isolation, tools and restart',async()=>{
  assert.equal(normalizeBaseUrl('http://localhost:8080/'),'http://localhost:8080/v1');assert.equal(normalizeBaseUrl('https://example.org/v1/chat/completions'),'https://example.org/v1');assert.throws(()=>normalizeBaseUrl('file:///secret'),/HTTP/);
  const dir=path.resolve('work/local-test-'+Date.now()),fixture=await localFixture();
  let encrypted='',server,ws;const vault={get:async()=>encrypted,set:async k=>{encrypted=k;},clear:async()=>{encrypted='';}};
  const events=[];
  try{
    server=await startServer({dataDir:dir,vault,autoStartUpdates:false});
    const api=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(server.url+'/api'+route,{method,headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
    const config=await api('/connect',{provider:'local',baseUrl:fixture.url,contextWindow:40000,maxTokens:25096,remember:true});
    assert.equal(config.connected,true);assert.equal(config.models[0].id,'qwen-local');assert.equal(config.models[0].provider,'bolt-local');assert.equal(config.models[0].contextWindow,40000);assert.equal(config.models[0].maxTokens,25096);
    assert.equal(fixture.requests[0].authorization,'');
    await api('/model',{modelId:'qwen-local'});assert.equal((await api('/config')).preferredModel,'qwen-local');
    const chat=await api('/chats',{});await api('/chats/'+chat.id,{model:'qwen-local',thinking:'medium'},'PATCH');
    ws=new WebSocket(server.url.replace('http','ws')+`/stream?chat=${chat.id}&token=${server.token}`);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.on('message',d=>events.push(JSON.parse(d)));
    const wait=async(type)=>{const until=Date.now()+25000;while(Date.now()<until){const error=events.find(e=>e.type==='app_error');if(error)throw new Error(error.message);const e=events.find(e=>e.type===type);if(e)return e;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out: '+type+' '+JSON.stringify(events).slice(-2000));};
    ws.send(JSON.stringify({type:'prompt',message:'Say hello'}));await wait('agent_settled');await wait('stats');
    assert.ok(events.some(e=>e.assistantMessageEvent?.type==='thinking_delta'));assert.ok(events.some(e=>e.assistantMessageEvent?.type==='text_delta'));
    const request=fixture.requests.find(r=>r.body);assert.equal(request.url,'/v1/chat/completions');assert.equal(request.body.stream,true);assert.equal(request.body.model,'qwen-local');assert.equal(request.body.max_tokens,25096);assert.equal(request.body.chat_template_kwargs.enable_thinking,true);
    assert.equal(events.find(e=>e.type==='stats').data.contextUsage.contextWindow,40000);
    assert.equal(events.find(e=>e.type==='stats').data.tokens.output,22);
    assert.equal(request.body.timings_per_token,true);
    assert.equal(events.find(e=>e.type==='message_end'&&e.message.role==='assistant').replyMetrics.tokensPerSecond,20);
    assert.equal(events.find(e=>e.type==='message_end'&&e.message.role==='assistant').replyMetrics.rateSource,'server-generation');
    events.length=0;await api('/chats/'+chat.id,{mode:'ask'},'PATCH');fixture.tool();ws.send(JSON.stringify({type:'prompt',message:'Create the file'}));const approval=await wait('extension_ui_request');ws.send(JSON.stringify({type:'ui_response',id:approval.id,confirmed:true}));await wait('agent_settled');assert.equal(await fs.readFile(path.join(dir,'workspace','local-tool.txt'),'utf8'),'Local tool passed');
    fixture.requireKey('local-secret-test');await api('/connect',{provider:'local',baseUrl:fixture.url,key:'local-secret-test',contextWindow:40000,maxTokens:25096,remember:true});
    assert.ok(encrypted.includes('local-secret-test'));const generated=await fs.readFile(path.join(dir,'agent','models.json'),'utf8');assert.ok(!generated.includes('local-secret-test'));assert.ok(!JSON.stringify(await api('/config')).includes('local-secret-test'));
    ws.close();server.close();server=await startServer({dataDir:dir,vault,autoStartUpdates:false});assert.equal((await api('/config')).connected,true);assert.equal((await api('/config')).connection.maxTokens,25096);assert.equal((await api('/config')).preferredModel,'qwen-local');
    const bad=await fetch(server.url+'/api/connect',{method:'POST',headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:JSON.stringify({provider:'local',baseUrl:fixture.url,contextWindow:1000,maxTokens:2000})});assert.equal(bad.status,400);assert.equal((await api('/config')).connection.contextWindow,40000);
    await api('/disconnect',{});server.close();server=await startServer({dataDir:dir,vault,autoStartUpdates:false});assert.equal((await api('/config')).connected,false);
  }finally{ws?.close();server?.close();fixture.close();}
});
