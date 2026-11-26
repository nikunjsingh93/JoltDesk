import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startServer} from '../server.mjs';

// Studio reports no image support until the model is loaded, and answers its status slowly.
async function fixture(){
  const state={loaded:false},requests=[];
  const http=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const {pathname}=new URL(req.url,'http://x');
    const json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    if(pathname==='/v1/models')return json({data:[{id:'vision-test',owned_by:'unsloth-studio',context_length:64000}]});
    if(pathname==='/v1/status'){
      if(state.loaded)await new Promise(r=>setTimeout(r,700));
      return json(state.loaded?{model_identifier:'vision-test',active_model:'vision-test',context_length:64000,is_vision:true}:{model_identifier:null});
    }
    if(pathname!=='/v1/chat/completions'){res.statusCode=404;return json({detail:'Not found'});}
    requests.push(JSON.parse(raw));
    res.setHeader('Content-Type','text/event-stream');
    const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'c1',object:'chat.completion.chunk',model:'vision-test',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    send({role:'assistant',content:'Ready.'});send({},'stop');res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  return {state,requests,url:'http://127.0.0.1:'+http.address().port,close:()=>http.close()};
}

for(const contextWindow of ['auto',32000]){
  test(`the first request carries an image once Studio reports vision (context ${contextWindow})`,async()=>{
    const studio=await fixture();let server,ws;
    try{
      server=await startServer({dataDir:path.resolve(`work/unsloth-vision-${contextWindow}-${Date.now()}`),autoStartUpdates:false});
      const api=async(route,body)=>{
        const r=await fetch(server.url+'/api'+route,{method:body?'POST':'GET',headers:{'X-Bolt-Token':server.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
        const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;
      };
      const config=await api('/connect',{provider:'local',name:'Studio',baseUrl:studio.url+'/v1',profile:'llamacpp',maxTokens:'auto',contextWindow});
      assert.deepEqual(config.models[0].input,['text']);
      const chat=await api('/chats',{});
      studio.state.loaded=true;
      const events=[];
      ws=new WebSocket(server.url.replace('http','ws')+`/stream?chat=${chat.id}&token=${server.token}`);
      ws.on('message',d=>events.push(JSON.parse(d)));
      await new Promise(r=>ws.once('open',r));
      const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
      ws.send(JSON.stringify({type:'prompt',message:'Describe this.',files:[{name:'dot.png',type:'image/png',data}]}));
      const until=Date.now()+20000;
      while(!events.some(e=>e.type==='agent_settled')){
        const error=events.find(e=>e.type==='app_error');if(error)throw new Error(error.message);
        if(Date.now()>until)throw new Error('Reply timed out');
        await new Promise(r=>setTimeout(r,20));
      }
      assert.match(JSON.stringify(studio.requests[0].messages),/"image_url"/);
      const saved=(await api('/config')).models[0];
      assert.deepEqual(saved.input,['text','image']);
      assert.equal(saved.contextWindow,contextWindow==='auto'?64000:32000);
    }finally{ws?.close();server?.close();studio.close();}
  });
}
