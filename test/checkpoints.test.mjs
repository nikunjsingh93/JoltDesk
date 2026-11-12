import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCheckpoints, readState } from '../checkpoints.mjs';

async function fixture(){
  const root=path.resolve('work','checkpoints-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  const project=path.join(root,'project');
  await fs.mkdir(project,{recursive:true});
  return {root,project,store:createCheckpoints(path.join(root,'store'))};
}
// Mirrors the approval extension: snapshot, then let the "tool" change the file.
async function edit(store,turn,file,content){
  await store.snapshot(turn,{path:file,...await readState(file)});
  if(content===null)await fs.rm(file,{force:true});
  else await fs.writeFile(file,content);
}

test('records per-turn edits and undoes a turn with its later turns',async()=>{
  const {project,store}=await fixture();
  const a=path.join(project,'a.txt'),b=path.join(project,'src','b.txt');
  await fs.writeFile(a,'one\ntwo\n');
  const first=await store.begin('chat1',{prompt:'First',cwd:project});
  await edit(store,first,a,'one\nTWO\n');
  await edit(store,first,a,'one\nTWO\nthree\n');
  await store.snapshot(first,{command:'bash'});
  const summary=await store.finish(first);
  assert.equal(summary.files.length,1);
  assert.deepEqual({display:summary.files[0].display,before:summary.files[0].before,after:summary.files[0].after},{display:'a.txt',before:2,after:3});
  assert.deepEqual(summary.commands,['bash']);

  await fs.mkdir(path.dirname(b),{recursive:true});
  const second=await store.begin('chat1',{prompt:'Second',cwd:project});
  await edit(store,second,b,'new file\n');
  await edit(store,second,a,'changed again\n');
  await store.finish(second);
  const turns=await store.list('chat1');
  assert.deepEqual(turns.map(t=>t.prompt),['Second','First']);
  assert.equal(turns[0].files.find(f=>f.path===b).created,true);

  const file=await store.file('chat1',second,a);
  assert.equal(Buffer.from(file.before.data,'base64').toString(),'one\nTWO\nthree\n');
  assert.equal(Buffer.from(file.after.data,'base64').toString(),'changed again\n');

  const result=await store.restore('chat1',first);
  assert.deepEqual(result.restored.sort(),[a,b].sort());
  assert.equal(await fs.readFile(a,'utf8'),'one\ntwo\n');
  await assert.rejects(fs.stat(b),{code:'ENOENT'});
  assert.deepEqual((await store.list('chat1')).map(t=>t.status),['undone','undone']);
});

test('reverts one file, keeps exact bytes and asks before overwriting outside edits',async()=>{
  const {project,store}=await fixture();
  const text=path.join(project,'notes.md'),latin=path.join(project,'latin.txt');
  const bytes=Buffer.from([0x63,0x61,0x66,0xe9,0x0a]);
  await fs.writeFile(text,'keep\n');await fs.writeFile(latin,bytes);
  const turn=await store.begin('chat2',{prompt:'Edit both',cwd:project});
  await edit(store,turn,text,'edited\n');
  await edit(store,turn,latin,'replaced\n');
  await store.finish(turn);

  const single=await store.restore('chat2',turn,{file:latin});
  assert.deepEqual(single.restored,[latin]);
  assert.deepEqual(await fs.readFile(latin),bytes);
  assert.equal(await fs.readFile(text,'utf8'),'edited\n');
  assert.equal((await store.list('chat2'))[0].status,'done');

  await fs.writeFile(text,'edited by the user\n');
  const blocked=await store.restore('chat2',turn);
  assert.equal(blocked.needsConfirmation,true);
  assert.deepEqual(blocked.conflicts,[text]);
  assert.equal(await fs.readFile(text,'utf8'),'edited by the user\n');
  const forced=await store.restore('chat2',turn,{force:true});
  assert.deepEqual(forced.restored,[text]);
  assert.equal(await fs.readFile(text,'utf8'),'keep\n');
  assert.equal((await store.list('chat2'))[0].status,'undone');
});

test('drops unchanged turns and skips untracked files',async()=>{
  const {project,store}=await fixture();
  const file=path.join(project,'same.txt');
  await fs.writeFile(file,'same\n');
  const turn=await store.begin('chat3',{prompt:'No change',cwd:project});
  await edit(store,turn,file,'same\n');
  assert.equal(await store.finish(turn),null);
  assert.deepEqual(await store.list('chat3'),[]);

  const big=await store.begin('chat3',{prompt:'Large',cwd:project});
  await store.snapshot(big,{path:file,exists:true,tracked:false,data:null});
  await fs.writeFile(file,'different\n');
  const summary=await store.finish(big);
  assert.equal(summary.files[0].tracked,false);
  const result=await store.restore('chat3',big);
  assert.deepEqual(result.skipped,[file]);
  assert.equal(await fs.readFile(file,'utf8'),'different\n');
  await assert.rejects(store.list('../escape'),/Invalid chat/);
});
