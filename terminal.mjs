// Terminal tab. Runs the user's commands in a chat's folder and mirrors the
// agent's bash and PowerShell tool calls, streaming output to open windows.
// Commands run without a pseudo-terminal: full-screen programs are not supported.
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_OUTPUT=200*1024,MAX_ENTRIES=40,FLUSH_MS=60;

function findShell(){
  if(process.platform!=='win32'){
    const shell=process.env.SHELL||'/bin/sh';
    return {name:path.basename(shell),file:shell,args:command=>['-c',command]};
  }
  let file='powershell.exe';
  try{execFileSync('where.exe',['pwsh.exe'],{stdio:'ignore',windowsHide:true});file='pwsh.exe';}catch{}
  return {name:file==='pwsh.exe'?'PowerShell 7':'Windows PowerShell',file,args:command=>['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command',command]};
}

const tail=text=>text.length>MAX_OUTPUT?'…(earlier output trimmed)\n'+text.slice(-MAX_OUTPUT):text;

export function createTerminals({emit}){
  let shell=null;
  const sessions=new Map(); // chatId -> {cwd, entries, processes}

  function session(chatId,defaultCwd){
    let s=sessions.get(chatId);
    if(!s){s={cwd:defaultCwd,home:defaultCwd,entries:[],processes:new Map(),pending:new Map(),timers:new Map()};sessions.set(chatId,s);}
    if(defaultCwd&&s.home!==defaultCwd){s.home=defaultCwd;if(!s.entries.some(e=>e.status==='running'))s.cwd=defaultCwd;}
    return s;
  }
  const view=entry=>({...entry});
  function add(chatId,s,entry){
    s.entries.push(entry);
    while(s.entries.length>MAX_ENTRIES){const old=s.entries.findIndex(e=>e.status!=='running');if(old<0)break;s.entries.splice(old,1);}
    emit(chatId,{type:'terminal',op:'start',entry:view(entry)});
  }
  // Batches output so fast commands do not flood the socket.
  function append(chatId,s,entry,text){
    entry.output=tail(entry.output+text);
    s.pending.set(entry.id,(s.pending.get(entry.id)||'')+text);
    if(s.timers.has(entry.id))return;
    s.timers.set(entry.id,setTimeout(()=>flush(chatId,s,entry.id),FLUSH_MS));
  }
  function flush(chatId,s,id){
    clearTimeout(s.timers.get(id));s.timers.delete(id);
    const text=s.pending.get(id);s.pending.delete(id);
    if(text)emit(chatId,{type:'terminal',op:'output',id,text});
  }
  function finish(chatId,s,entry,fields){
    flush(chatId,s,entry.id);
    Object.assign(entry,fields,{endedAt:Date.now()});
    emit(chatId,{type:'terminal',op:'end',entry:view(entry)});
  }

  function kill(child){
    if(!child||child.exitCode!==null)return;
    if(process.platform==='win32'){
      try{spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
    }else{try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}}
  }

  return {
    state(chatId,cwd){
      shell||=findShell();
      const s=session(chatId,cwd);
      return {cwd:s.cwd,shell:shell.name,entries:s.entries.map(view)};
    },
    async run(chatId,cwd,command){
      shell||=findShell();
      const s=session(chatId,cwd);
      const text=String(command||'').trim();
      if(!text)throw new Error('Type a command to run.');
      if(text.length>8000)throw new Error('This command is too long.');
      if(s.entries.filter(e=>e.status==='running'&&e.source==='you').length>=4)throw new Error('Wait for a running command to finish, or stop it.');
      const entry={id:randomUUID(),source:'you',command:text,cwd:s.cwd,shell:shell.name,status:'running',output:'',startedAt:Date.now()};
      // cd changes this chat's terminal folder instead of starting a process.
      const cd=/^(?:cd|chdir|Set-Location|sl)(?:\s+(.*))?$/i.exec(text);
      if(cd){
        let target=(cd[1]||'').trim().replace(/^(["'])(.*)\1$/,'$2');
        if(!target)target=s.home;
        else if(target==='~'||/^~[\\/]/.test(target))target=path.join(homedir(),target.slice(1));
        target=path.resolve(s.cwd,target);
        add(chatId,s,entry);
        const stat=await fs.stat(target).catch(()=>null);
        if(stat?.isDirectory()){s.cwd=target;finish(chatId,s,entry,{status:'done',exitCode:0});emit(chatId,{type:'terminal',op:'cwd',cwd:target});}
        else{append(chatId,s,entry,`The folder ${target} does not exist.\n`);finish(chatId,s,entry,{status:'failed',exitCode:1});}
        return view(entry);
      }
      if(!(await fs.stat(s.cwd).catch(()=>null))?.isDirectory())throw new Error('The terminal folder no longer exists. Run cd to choose another.');
      const child=spawn(shell.file,shell.args(text),{cwd:s.cwd,windowsHide:true,detached:process.platform!=='win32',
        env:{...process.env,TERM:'dumb',NO_COLOR:'1',FORCE_COLOR:'0',GIT_TERMINAL_PROMPT:'0'}});
      s.processes.set(entry.id,child);
      add(chatId,s,entry);
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',data=>append(chatId,s,entry,data));
      child.stderr.on('data',data=>append(chatId,s,entry,data));
      child.stdin.on('error',()=>{});
      child.on('error',error=>{append(chatId,s,entry,error.message+'\n');});
      child.on('close',code=>{
        s.processes.delete(entry.id);
        finish(chatId,s,entry,{status:entry.stopping?'stopped':code===0?'done':'failed',exitCode:code});
      });
      return view(entry);
    },
    input(chatId,id,text){
      const child=sessions.get(chatId)?.processes.get(id);
      if(!child)throw new Error('This command is no longer running.');
      child.stdin.write(String(text)+'\n');
      const s=sessions.get(chatId),entry=s.entries.find(e=>e.id===id);
      if(entry)append(chatId,s,entry,String(text)+'\n');
    },
    stop(chatId,id){
      const s=sessions.get(chatId);
      const child=s?.processes.get(id),entry=s?.entries.find(e=>e.id===id);
      if(!child||!entry)throw new Error('This command is no longer running.');
      entry.stopping=true;kill(child);
    },
    clear(chatId){
      const s=sessions.get(chatId);
      if(!s)return;
      s.entries=s.entries.filter(e=>e.status==='running');
      emit(chatId,{type:'terminal',op:'clear',keep:s.entries.map(e=>e.id)});
    },
    // Mirrors of the agent's command tools, fed from engine events.
    agentStart(chatId,cwd,{id,tool,command}){
      shell||=findShell();
      const s=session(chatId,cwd);
      if(s.entries.some(e=>e.id===id))return;
      add(chatId,s,{id,source:'agent',command:String(command||''),cwd:s.home,shell:tool==='powershell'?'PowerShell':'bash',status:'running',output:'',startedAt:Date.now()});
    },
    agentOutput(chatId,id,text){
      const s=sessions.get(chatId),entry=s?.entries.find(e=>e.id===id);
      if(!entry||entry.status!=='running'||typeof text!=='string')return;
      // The engine reports all output so far; send only the new part when possible.
      if(text.startsWith(entry.output))append(chatId,s,entry,text.slice(entry.output.length));
      else{entry.output=tail(text);flush(chatId,s,id);emit(chatId,{type:'terminal',op:'replace',id,text:entry.output});}
    },
    agentEnd(chatId,id,{text,exitCode,isError}){
      const s=sessions.get(chatId),entry=s?.entries.find(e=>e.id===id);
      if(!entry||entry.status!=='running')return;
      if(typeof text==='string'&&text!==entry.output){entry.output=tail(text);flush(chatId,s,id);emit(chatId,{type:'terminal',op:'replace',id,text:entry.output});}
      finish(chatId,s,entry,{status:isError?'failed':'done',exitCode:exitCode??(isError?1:0)});
    },
    // Marks agent commands that never reported an end, for example after an abort.
    agentSettled(chatId){
      const s=sessions.get(chatId);
      for(const entry of s?.entries||[])if(entry.source==='agent'&&entry.status==='running')finish(chatId,s,entry,{status:'stopped',exitCode:null});
    },
    close(chatId){
      const s=sessions.get(chatId);
      if(!s)return;
      for(const child of s.processes.values())kill(child);
      for(const timer of s.timers.values())clearTimeout(timer);
      sessions.delete(chatId);
    },
    closeAll(){for(const id of [...sessions.keys()])this.close(id);}
  };
}
