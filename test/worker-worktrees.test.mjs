import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerWorktree, inspectWorkerWorktree } from '../worker-worktrees.mjs';
import { delegateTasks } from '../subagents.mjs';
const run=(cwd,...args)=>execFileSync('git',args,{cwd,stdio:'pipe',windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}}).toString();
test('parallel worker worktrees use committed HEAD without touching user edits',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jolt-workers-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'project');await fs.mkdir(repo);run(repo,'init');run(repo,'config','core.autocrlf','false');run(repo,'config','user.name','Test');run(repo,'config','user.email','test@example.invalid');
  await fs.writeFile(path.join(repo,'file.txt'),'committed\n');run(repo,'add','file.txt');run(repo,'commit','-m','fixture');
  await fs.writeFile(path.join(repo,'file.txt'),'user edit\n');
  await assert.rejects(createWorkerWorktree({cwd:repo,worktreeRoot:path.join(root,'blocked'),requireClean:true}),/uncommitted/);
  assert.equal(await fs.stat(path.join(root,'blocked')).then(()=>true,()=>false),false);
  const workers=await Promise.all([1,2].map(()=>createWorkerWorktree({cwd:repo,worktreeRoot:path.join(root,'workers')})));
  assert.notEqual(workers[0].path,workers[1].path);assert.ok(workers.every(w=>w.sourceDirty));
  assert.equal(await fs.readFile(path.join(workers[0].path,'file.txt'),'utf8'),'committed\n');
  await fs.writeFile(path.join(workers[0].path,'file.txt'),'worker edit\n');
  await fs.writeFile(path.join(workers[0].path,'new.txt'),'new\n');
  const result=await inspectWorkerWorktree(workers[0]);assert.match(result.diff,/worker edit/);assert.match(result.status,/new\.txt/);assert.deepEqual(result.newFiles,[{path:'new.txt',content:'new\n'}]);
  assert.equal(await fs.readFile(path.join(repo,'file.txt'),'utf8'),'user edit\n');
  assert.equal(await fs.readFile(path.join(workers[1].path,'file.txt'),'utf8'),'committed\n');
});


test('cancelled worker reports cancellation without touching the project',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jolt-worker-abort-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'project');await fs.mkdir(repo);run(repo,'init');run(repo,'config','user.name','Test');run(repo,'config','user.email','test@example.invalid');
  await fs.writeFile(path.join(repo,'file.txt'),'base');run(repo,'add','file.txt');run(repo,'commit','-m','base');
  const controller=new AbortController();let began;const started=new Promise(r=>began=r);
  const result=delegateTasks({cwd:repo,worktreeRoot:path.join(root,'workers'),slots:[{model:'test'}],tasks:['task'],mode:'coding',signal:controller.signal,runWorker:({signal})=>new Promise((resolve,reject)=>{began();signal.addEventListener('abort',()=>reject(new Error('Worker cancelled.')),{once:true});})});
  await started;controller.abort();const [worker]=await result;assert.match(worker.error,/cancelled/);assert.equal(await fs.readFile(path.join(repo,'file.txt'),'utf8'),'base');
});


test('question workers do not need a repository or create worktrees',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jolt-worker-questions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const calls=[];const results=await delegateTasks({cwd:path.join(root,'not-a-project'),worktreeRoot:path.join(root,'worktrees'),slots:[{model:'a'},{model:'b'}],tasks:['First question','Second question'],runWorker:async({slot,mode,task,worktree})=>{calls.push({slot,mode,task,worktree});return 'Independent answer';}});
  assert.equal(results.length,2);assert.ok(results.every(r=>r.mode==='questions'&&r.answer==='Independent answer'&&!r.worktree));
  assert.ok(calls.every(c=>c.mode==='questions'&&!c.worktree.path));
  assert.equal(await fs.stat(path.join(root,'worktrees')).then(()=>true,()=>false),false);
});
