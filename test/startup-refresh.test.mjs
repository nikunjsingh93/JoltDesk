import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';

// A slow model server should not delay JoltDesk's startup.
test('startup uses saved models and checks the API in the background',async()=>{
  let delay=0,listed=['first-model'];
  const api=createServer(async(req,res)=>{
    for await(const _ of req);
    await new Promise(r=>setTimeout(r,delay));
    res.setHeader('Content-Type','application/json');
    if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:listed.map(id=>({id}))}));
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const dir=path.resolve('work','startup-refresh-'+Date.now());
  await fs.mkdir(dir,{recursive:true});
  const call=async(server,url,body)=>{const r=await fetch(server.url+'/api'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
  let server=await startServer({dataDir:dir,autoStartUpdates:false});
  try{
    await call(server,'/connect',{provider:'local',baseUrl:`http://127.0.0.1:${api.address().port}/v1`,profile:'generic',name:'Slow API',key:'',maxTokens:'auto'});
  }finally{server.close();}

  delay=8000;listed=['first-model','second-model'];
  const started=Date.now();
  server=await startServer({dataDir:dir,autoStartUpdates:false});
  try{
    assert.ok(Date.now()-started<4000,`startup took ${Date.now()-started} ms`);
    let config=await call(server,'/config');
    assert.equal(config.connected,true);
    assert.equal(config.refreshing,true);
    assert.deepEqual(config.models.map(m=>m.id),['first-model']);
    for(let i=0;i<60&&config.refreshing;i++){await new Promise(r=>setTimeout(r,500));config=await call(server,'/config');}
    assert.equal(config.refreshing,false);
    assert.deepEqual(config.models.map(m=>m.id),['first-model','second-model']);
  }finally{server.close();api.close();}
});
