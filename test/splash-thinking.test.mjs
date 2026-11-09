import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import path from 'node:path';import {WebSocket} from 'ws';import {discoverLocal} from '../connections.mjs';import {startServer} from '../server.mjs';
export async function splashFixture({advertised=false,distinct=true}={}){
 const requests=[],templates=[];const http=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end(JSON.stringify(req.url.endsWith('/models')?{data:[{id:'qwen-local',root:'Qwen3.8',owned_by:'splash',context_length:40000,...(advertised?{reasoning:{thinks:true,efforts:['low','medium','xhigh'],default:'medium'}}:{})}]}:{}));return;}
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  if(req.url==='/apply-template'){templates.push(body);res.end(JSON.stringify({prompt:'Hello '+(distinct?body.reasoning_effort:'thinking')}));return;}
  requests.push(body);res.setHeader('Content-Type','text/event-stream');const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'splash-test',object:'chat.completion.chunk',model:'qwen-local',choices:[{index:0,delta,finish_reason}]})+'\n\n');send({role:'assistant'});send({reasoning_content:'A short thought.'});send({content:'Ready.'});send({},'stop');res.end('data: [DONE]\n\n');
 });await new Promise(r=>http.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+http.address().port,requests,templates,close:()=>http.close()};
}
if(process.env.BOLT_FIXTURE_ONLY!=='1'){
 test('Splash uses advertised efforts or distinct legacy templates, without inventing levels',async()=>{
  for(const options of [{advertised:true},{distinct:true},{distinct:false}]){const fixture=await splashFixture(options);try{
   const {definition}=await discoverLocal({baseUrl:fixture.url+'/v1',maxTokens:'auto'},'');const m=definition.models[0];const levels=Object.keys(m.thinkingLevelMap).filter(k=>m.thinkingLevelMap[k]!==null);
   assert.deepEqual(levels,options.distinct===false?['off','medium']:['off','low','medium','xhigh']);assert.equal(fixture.requests.length,0);assert.equal(fixture.templates.length,options.advertised?0:3);
  }finally{fixture.close();}}
 });
 test('real Pi-Bolt sends the selected Splash effort and saved budget; blank restores server default',async()=>{
  const fixture=await splashFixture(),dir=path.resolve('work/splash-thinking-'+Date.now());let server,ws;
  const api=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(server.url+'/api'+route,{method,headers:{'X-Bolt-Token':server.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const p=await r.json();assert.equal(r.status,200,JSON.stringify(p));return p;};
  try{server=await startServer({dataDir:dir,autoStartUpdates:false});let c=await api('/connect',{provider:'local',baseUrl:fixture.url+'/v1',name:'Splash',maxTokens:'auto',thinkingTokenBudget:2048});assert.equal(c.connection.thinkingTokenBudget,2048);assert.equal(c.models[0].splashThinkingBudget,true);
   const chat=await api('/chats',{});const events=[];ws=new WebSocket(server.url.replace('http','ws')+`/stream?chat=${chat.id}&token=${server.token}`);ws.on('message',d=>events.push(JSON.parse(d)));await new Promise(r=>ws.once('open',r));
   const send=async level=>{await api('/chats/'+chat.id,{thinking:level},'PATCH');events.length=0;ws.send(JSON.stringify({type:'prompt',message:'Reply briefly.'}));const end=Date.now()+15000;while(!events.some(e=>e.type==='agent_settled')){const error=events.find(e=>e.type==='app_error');if(error)throw new Error(error.message);if(Date.now()>end)throw new Error('Reply timed out');await new Promise(r=>setTimeout(r,20));}return fixture.requests.at(-1);};
   for(const level of ['low','medium','xhigh','off']){const body=await send(level);assert.equal(body.reasoning_effort,level==='off'?'none':level);assert.equal(body.chat_template_kwargs.enable_thinking,level!=='off');assert.equal(body.thinking_token_budget,2048);assert.equal(body.max_tokens,undefined);}
   c=await api('/connections/'+c.connection.id+'/settings',{provider:'local',baseUrl:fixture.url+'/v1',name:'Splash',maxTokens:'auto',thinkingTokenBudget:''});assert.equal(c.connection.thinkingTokenBudget,null);assert.equal((await send('low')).thinking_token_budget,undefined);
   c=await api('/connections/'+c.connection.id+'/settings',{provider:'local',baseUrl:fixture.url+'/v1',name:'Splash',maxTokens:'auto',thinkingTokenBudget:0});assert.equal(c.connection.thinkingTokenBudget,0);assert.equal((await send('medium')).thinking_token_budget,0);
   ws.close();server.close();server=await startServer({dataDir:dir,autoStartUpdates:false});assert.equal((await api('/config')).connection.thinkingTokenBudget,0);
  }finally{ws?.close();server?.close();fixture.close();}
 });
}
