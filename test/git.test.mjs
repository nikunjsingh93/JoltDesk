import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { status, fileChange, commit, push, changeSummary } from '../git.mjs';

const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}}).trim();
async function repo(){
  const dir=path.resolve('work','git-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  await fs.mkdir(dir,{recursive:true});
  git(dir,'init','-q','-b','main');
  git(dir,'config','user.name','JoltDesk Test');git(dir,'config','user.email','test@example.invalid');
  git(dir,'config','commit.gpgsign','false');
  return dir;
}

test('reports a missing repository',async()=>{
  const dir=path.resolve('work','not-a-repo-'+Date.now());
  await fs.mkdir(dir,{recursive:true});
  // A parent folder may itself be a repository, so isolate with GIT_CEILING_DIRECTORIES.
  process.env.GIT_CEILING_DIRECTORIES=path.dirname(dir);
  try{assert.deepEqual(await status(dir),{repo:false});}
  finally{delete process.env.GIT_CEILING_DIRECTORIES;}
});

test('first commit, status, diffs and selective commits',async()=>{
  const dir=await repo();
  await fs.writeFile(path.join(dir,'a.txt'),'one\n');
  await fs.writeFile(path.join(dir,'b file.txt'),'two\n');
  let state=await status(dir);
  assert.equal(state.unborn,true);
  assert.equal(state.branch,'main');
  assert.deepEqual(state.files.map(f=>[f.path,f.code]).sort(),[['a.txt','?'],['b file.txt','?']]);
  const summary=await changeSummary(dir,['a.txt']);
  assert.match(summary.diff,/New file: a.txt\none/);
  assert.deepEqual(await commit(dir,{message:'Initial commit',paths:['a.txt','b file.txt']}),{short:git(dir,'rev-parse','--short','HEAD'),subject:'Initial commit'});

  await fs.writeFile(path.join(dir,'a.txt'),'one\nmore\n');
  await fs.writeFile(path.join(dir,'b file.txt'),'changed\n');
  await fs.mkdir(path.join(dir,'src'));
  await fs.writeFile(path.join(dir,'src','new.txt'),'fresh\n');
  state=await status(dir);
  assert.deepEqual(state.files.map(f=>[f.path,f.code]).sort(),[['a.txt','M'],['b file.txt','M'],['src/new.txt','?']]);
  const change=await fileChange(dir,'a.txt');
  assert.equal(Buffer.from(change.before.data,'base64').toString(),'one\n');
  assert.equal(Buffer.from(change.after.data,'base64').toString(),'one\nmore\n');
  assert.equal((await fileChange(dir,'src/new.txt')).before.exists,false);
  assert.match((await changeSummary(dir,['a.txt'])).diff,/\+more/);

  // Only the selected files are committed, including a new untracked file.
  await commit(dir,{message:'Add more\n\nBody line',paths:['a.txt','src/new.txt']});
  assert.equal(git(dir,'log','-1','--format=%B'),'Add more\n\nBody line');
  assert.deepEqual(git(dir,'show','--name-only','--format=','HEAD').split('\n').sort(),['a.txt','src/new.txt']);
  state=await status(dir);
  assert.deepEqual(state.files.map(f=>f.path),['b file.txt']);
  assert.equal(state.commits[0].subject,'Add more');
  assert.equal(state.commits.length,2);

  await assert.rejects(commit(dir,{message:'x',paths:['missing.txt']}),/no changes/);
  await assert.rejects(commit(dir,{message:'  ',paths:['b file.txt']}),/commit message/);
  await assert.rejects(push(dir),/no remote/);
});

test('renames, deletions and pushing to a new upstream',async()=>{
  const dir=await repo();
  const remote=path.join(dir+'-remote.git');
  git(path.dirname(dir),'init','-q','--bare',remote);
  await fs.writeFile(path.join(dir,'old.txt'),'same content\n');
  await fs.writeFile(path.join(dir,'gone.txt'),'bye\n');
  await commit(dir,{message:'Base',paths:['old.txt','gone.txt']});
  git(dir,'mv','old.txt','new.txt');
  await fs.rm(path.join(dir,'gone.txt'));
  let state=await status(dir);
  const renamed=state.files.find(f=>f.path==='new.txt');
  assert.equal(renamed.from,'old.txt');
  assert.equal(state.files.find(f=>f.path==='gone.txt').code,'D');
  assert.equal(Buffer.from((await fileChange(dir,'new.txt')).before.data,'base64').toString(),'same content\n');
  await commit(dir,{message:'Rename and delete',paths:['new.txt','gone.txt']});
  assert.deepEqual((await status(dir)).files,[]);
  assert.deepEqual(git(dir,'ls-files').split('\n'),['new.txt']);

  git(dir,'remote','add','origin',remote);
  await push(dir);
  state=await status(dir);
  assert.equal(state.upstream,'origin/main');
  assert.equal(state.ahead,0);
  await fs.writeFile(path.join(dir,'new.txt'),'edited\n');
  await commit(dir,{message:'Edit',paths:['new.txt']});
  assert.equal((await status(dir)).ahead,1);
  await push(dir);
  assert.equal((await status(dir)).ahead,0);
  assert.equal(git(remote,'log','-1','--format=%s','main'),'Edit');
});
