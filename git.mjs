// Git operations for the Git tab, run through the git CLI in a chat's folder.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_FILE_BYTES=5*1024*1024;
const queues=new Map();

function run(cwd,args,{input,timeout=20000,allowFailure=false}={}){
  return new Promise((resolve,reject)=>{
    const child=execFile('git',['-c','core.quotepath=off','--literal-pathspecs',...args],{
      cwd,timeout,maxBuffer:64*1024*1024,encoding:'buffer',windowsHide:true,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'}
    },(error,stdout,stderr)=>{
      if(error&&error.code==='ENOENT')return reject(new Error('Git is not installed or not on PATH.'));
      if(error&&!allowFailure){
        const message=stderr.toString('utf8').trim().split('\n').filter(l=>!/^hint:/.test(l)).slice(-6).join('\n');
        return reject(new Error(message||error.message));
      }
      resolve({stdout,stderr:stderr.toString('utf8'),code:error?error.code:0});
    });
    if(input!==undefined)child.stdin.end(input);
  });
}

// Serializes changes per repository so commits and pushes never overlap.
function exclusive(root,task){
  const next=(queues.get(root)||Promise.resolve()).then(task,task);
  queues.set(root,next.catch(()=>{}));
  return next;
}

export async function repoRoot(cwd){
  if(!(await fs.stat(cwd).catch(()=>null))?.isDirectory())throw new Error('This chat’s folder no longer exists.');
  const result=await run(cwd,['rev-parse','--show-toplevel'],{allowFailure:true});
  if(result.code)return null;
  return path.resolve(result.stdout.toString('utf8').trim());
}

function parseBranch(line){
  const info={branch:null,upstream:null,ahead:0,behind:0,detached:false,unborn:false};
  let text=line.slice(3);
  if(text.startsWith('No commits yet on ')){info.branch=text.slice(18);info.unborn=true;return info;}
  if(text.startsWith('HEAD (no branch)')){info.detached=true;info.branch='HEAD';return info;}
  const tracking=/^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(text);
  info.branch=tracking[1];info.upstream=tracking[2]||null;
  const counts=tracking[3]||'';
  info.ahead=Number(/ahead (\d+)/.exec(counts)?.[1]||0);
  info.behind=Number(/behind (\d+)/.exec(counts)?.[1]||0);
  return info;
}

const LABELS={M:'modified',A:'added',D:'deleted',R:'renamed',C:'copied',U:'conflict','?':'untracked',T:'type changed'};

export async function status(cwd){
  const root=await repoRoot(cwd);
  if(!root)return {repo:false};
  const raw=(await run(root,['status','--porcelain=v1','-z','-b','--untracked-files=all'])).stdout.toString('utf8').split('\0');
  const info=parseBranch(raw[0]||'## HEAD');
  const files=[];
  for(let i=1;i<raw.length;i++){
    const entry=raw[i];
    if(!entry)continue;
    const index=entry[0],worktree=entry[1],file=entry.slice(3);
    let from=null;
    if(index==='R'||index==='C')from=raw[++i]||null;
    const conflict=index==='U'||worktree==='U'||(index==='A'&&worktree==='A')||(index==='D'&&worktree==='D');
    const code=index==='?'?'?':conflict?'U':worktree!==' '?worktree:index;
    files.push({path:file,from,index,worktree,code,label:LABELS[code]||'changed'});
  }
  const log=await run(root,['log','-n','15','--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e'],{allowFailure:true});
  const commits=log.code?[]:log.stdout.toString('utf8').split('\x1e').map(r=>r.trim()).filter(Boolean).map(r=>{
    const [hash,short,subject,author,time]=r.split('\x1f');
    return {hash,short,subject,author,time:Number(time)*1000};
  });
  const remotes=(await run(root,['remote'],{allowFailure:true})).stdout.toString('utf8').split('\n').filter(Boolean);
  return {repo:true,root,...info,files,commits,remotes};
}

async function readWorking(root,file){
  try{
    const full=path.join(root,file);
    const stat=await fs.lstat(full);
    if(!stat.isFile())return {exists:true,tracked:false,data:null};
    if(stat.size>MAX_FILE_BYTES)return {exists:true,tracked:false,data:null};
    return {exists:true,tracked:true,data:(await fs.readFile(full)).toString('base64')};
  }catch(error){return error.code==='ENOENT'?{exists:false,tracked:true,data:null}:{exists:true,tracked:false,data:null};}
}

async function readHead(root,file){
  const size=await run(root,['cat-file','-s','HEAD:'+file],{allowFailure:true});
  if(size.code)return {exists:false,tracked:true,data:null};
  if(Number(size.stdout.toString())>MAX_FILE_BYTES)return {exists:true,tracked:false,data:null};
  const blob=await run(root,['cat-file','blob','HEAD:'+file]);
  return {exists:true,tracked:true,data:blob.stdout.toString('base64')};
}

// Before (HEAD) and after (working tree) contents of one changed file.
export async function fileChange(cwd,file){
  const state=await status(cwd);
  if(!state.repo)throw new Error('This folder is not a Git repository.');
  const entry=state.files.find(f=>f.path===file);
  if(!entry)throw new Error('This file has no changes.');
  return {path:file,before:await readHead(state.root,entry.from||file),after:await readWorking(state.root,file)};
}

function selected(state,paths){
  if(!Array.isArray(paths)||!paths.length)throw new Error('Choose at least one file to commit.');
  const chosen=[];
  for(const file of paths){
    const entry=state.files.find(f=>f.path===file);
    if(!entry)throw new Error(`${file} has no changes to commit.`);
    if(entry.code==='U')throw new Error(`Resolve the merge conflict in ${file} first.`);
    chosen.push(entry);
  }
  return chosen;
}

export async function commit(cwd,{message,paths}){
  const text=String(message||'').trim();
  if(!text)throw new Error('Write a commit message.');
  const state=await status(cwd);
  if(!state.repo)throw new Error('This folder is not a Git repository.');
  const chosen=selected(state,paths);
  const specs=[...new Set(chosen.flatMap(f=>f.from?[f.path,f.from]:[f.path]))];
  // Renamed-from paths and staged deletions are already recorded in the index.
  const additions=chosen.filter(f=>f.index!=='D').map(f=>f.path);
  return exclusive(state.root,async()=>{
    const list=specs.join('\0')+'\0';
    const messageFile=path.join(tmpdir(),'joltdesk-commit-'+randomBytes(6).toString('hex')+'.txt');
    await fs.writeFile(messageFile,text+'\n');
    try{
      if(additions.length)await run(state.root,['add','-A','--pathspec-from-file=-','--pathspec-file-nul'],{input:additions.join('\0')+'\0'});
      const args=['commit','--file',messageFile,'--cleanup=strip'];
      // A first commit has no HEAD to compare against, so commit the staged selection.
      if(!state.unborn)args.push('--only','--pathspec-from-file=-','--pathspec-file-nul');
      await run(state.root,args,{input:state.unborn?undefined:list,timeout:60000});
    }finally{await fs.rm(messageFile,{force:true});}
    const head=(await run(state.root,['log','-1','--format=%h%x1f%s'])).stdout.toString('utf8').trim().split('\x1f');
    return {short:head[0],subject:head[1]};
  });
}

export async function push(cwd){
  const state=await status(cwd);
  if(!state.repo)throw new Error('This folder is not a Git repository.');
  if(state.detached)throw new Error('Check out a branch before pushing.');
  if(!state.upstream&&!state.remotes.length)throw new Error('This repository has no remote to push to.');
  return exclusive(state.root,async()=>{
    const remote=state.remotes.includes('origin')?'origin':state.remotes[0];
    const args=state.upstream?['push']:['push','--set-upstream',remote,'HEAD'];
    const result=await run(state.root,args,{timeout:180000});
    return {output:result.stderr.trim().split('\n').slice(-4).join('\n')};
  });
}

// Compact description of the selected changes, used to ask a model for a commit message.
export async function changeSummary(cwd,paths,limit=16000){
  const state=await status(cwd);
  if(!state.repo)throw new Error('This folder is not a Git repository.');
  const chosen=selected(state,paths);
  let text='';
  const tracked=chosen.filter(f=>f.code!=='?').flatMap(f=>f.from?[f.path,f.from]:[f.path]);
  if(tracked.length&&!state.unborn){
    const diff=await run(state.root,['diff','HEAD','--stat','--patch','--no-color','--no-ext-diff','--',...tracked.slice(0,200)]);
    text+=diff.stdout.toString('utf8');
  }
  for(const file of chosen.filter(f=>f.code==='?'||state.unborn)){
    if(text.length>limit)break;
    const content=await readWorking(state.root,file.path);
    const body=content.data?Buffer.from(content.data,'base64').toString('utf8'):'';
    text+=`\nNew file: ${file.path}\n`+(body.includes('\0')?'(binary)\n':body.slice(0,3000)+'\n');
  }
  return {branch:state.branch,files:chosen.map(f=>`${f.label}: ${f.path}`),diff:text.length>limit?text.slice(0,limit)+'\n…(truncated)':text};
}
