import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {startServer} from '../server.mjs';
import {discoverLocal} from '../connections.mjs';

test('rename persists, deleting archives files and cannot resurrect through recovery or stale metadata',async()=>{
 const dir=path.resolve('work/chat-management-'+Date.now());let server=await startServer({dataDir:dir,autoStartUpdates:false});
 const request=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(server.url+'/api'+route,{method,headers:{'X-Bolt-Token':server.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 try{
  const {data:chat}=await request('/chats',{});const route='/chats/'+chat.id;
  assert.equal((await request(route,{title:'   '},'PATCH')).status,400);
  assert.equal((await request(route,{title:'  Renamed chat  '},'PATCH')).data.title,'Renamed chat');
  server.close();server=await startServer({dataDir:dir,autoStartUpdates:false});
  assert.equal((await request('/config')).data.chats[0].title,'Renamed chat');
  const file='2026-11-08_'+chat.id+'.jsonl',session=JSON.stringify({type:'session',id:chat.id})+'\n'+JSON.stringify({type:'message',message:{role:'user',content:'recover me'}})+'\n';
  await fs.writeFile(path.join(dir,'sessions',file),session);
  await fs.writeFile(path.join(dir,'reply-metrics',chat.id+'.json'),'{}');
  assert.equal((await request(route,{},'DELETE')).status,200);
  assert.equal((await request('/config')).data.chats.length,0);
  assert.equal(await fs.readFile(path.join(dir,'trash',chat.id,file),'utf8'),session);
  assert.equal((await request(route,{},'DELETE')).status,404);
  // Simulate an older instance leaving the session and metadata behind.
  await fs.writeFile(path.join(dir,'sessions',file),session);
  const disk=JSON.parse(await fs.readFile(path.join(dir,'workspace.json'),'utf8'));disk.chats=[chat];await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(disk));
  server.close();server=await startServer({dataDir:dir,autoStartUpdates:false});
  assert.ok(!(await request('/config')).data.chats.some(c=>c.id===chat.id));
  await request('/chats',{});
  assert.ok(!(await request('/config')).data.chats.some(c=>c.id===chat.id));
 }finally{server.close();}
});

test('Splash resident aliases show qwen-local once while unrelated models remain visible',async()=>{
 const result=await discoverLocal({baseUrl:'http://localhost:8000/v1',profile:'generic'},'',async()=>new Response(JSON.stringify({data:[{id:'unsloth/Qwen',owned_by:'splash'},{id:'qwen-local',root:'unsloth/Qwen',owned_by:'splash'},{id:'other-model',owned_by:'splash'},{id:'fine-tune',root:'other-model',owned_by:'other'}]})));
 assert.deepEqual(result.definition.models.map(m=>m.id),['qwen-local','other-model','fine-tune']);
});
