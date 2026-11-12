import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function git(cwd,args,{allowFailure=false}={}){
  return new Promise((resolve,reject)=>execFile('git',args,{cwd,windowsHide:true,timeout:30000,maxBuffer:16*1024*1024,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}},(error,stdout,stderr)=>{
    if(error&&!allowFailure)return reject(new Error((stderr||error.message).trim()));
    resolve({stdout,stderr,code:error?error.code:0});
  }));
}
const queues=new Map();
function serial(key,task){
  const next=(queues.get(key)||Promise.resolve()).then(task,task);
  const settled=next.catch(()=>{});queues.set(key,settled);settled.finally(()=>{if(queues.get(key)===settled)queues.delete(key);});return next;
}
// Worker worktrees always start from a committed HEAD. Never copy or stash the
// user's changes: callers must clearly tell the lead when the source is dirty.
export async function workerBase(cwd,{requireClean=false}={}){
  const root=await git(cwd,['rev-parse','--show-toplevel']);
  const repo=path.resolve(root.stdout.trim());
  const head=(await git(repo,['rev-parse','--verify','HEAD'])).stdout.trim();
  const status=await git(repo,['status','--porcelain=v1','-z','--untracked-files=all']);
  if(requireClean&&status.stdout)throw new Error('The project has uncommitted or untracked changes. Workers start from HEAD; commit or move those changes before delegating.');
  return {repo,head,sourceDirty:!!status.stdout};
}
export async function createWorkerWorktree({cwd,worktreeRoot,requireClean=false,base}){
  const info=base||await workerBase(cwd,{requireClean});
  const id=randomUUID(),root=path.resolve(worktreeRoot),target=path.join(root,id);
  await fs.mkdir(root,{recursive:true});
  await serial(info.repo,()=>git(info.repo,['worktree','add','--detach',target,info.head]));
  return {id,repo:info.repo,path:target,head:info.head,sourceDirty:info.sourceDirty};
}
// Returns binary-safe patches and the names of untracked files separately; files
// remain in the worktree until the user explicitly decides how to proceed.
export async function inspectWorkerWorktree(worktree){
  const [status,diff,untracked]=await Promise.all([
    git(worktree.path,['status','--porcelain=v1','--untracked-files=all']),
    git(worktree.path,['diff','--binary','HEAD','--']),
    git(worktree.path,['ls-files','--others','--exclude-standard','-z'])
  ]);
  const limit=100000,newFiles=[];let remaining=limit;
  for(const name of untracked.stdout.split('\0').filter(Boolean)){
    const full=path.resolve(worktree.path,name);if(!full.startsWith(path.resolve(worktree.path)+path.sep))continue;
    const info=await fs.lstat(full);if(!info.isFile()||info.isSymbolicLink()){newFiles.push({path:name,note:'Not a regular file; inspect in the worktree.'});continue;}
    if(info.size>remaining){newFiles.push({path:name,note:'Too large to display; inspect in the worktree.'});continue;}
    const bytes=await fs.readFile(full);remaining-=bytes.length;
    newFiles.push(bytes.includes(0)?{path:name,note:'Binary file; inspect in the worktree.'}:{path:name,content:bytes.toString('utf8')});
  }
  return {status:status.stdout.slice(0,limit),diff:diff.stdout.slice(0,limit),newFiles,truncated:status.stdout.length>limit||diff.stdout.length>limit};
}
