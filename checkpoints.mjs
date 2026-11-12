// Per-turn file checkpoints for agent edits. The approval extension reports each
// file's exact bytes before a write or edit runs; the server records the result
// when the turn settles. Restoring returns files to their state before a turn.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { diffLines, countChanges } from './public/diff.mjs';

export const MAX_TRACKED_BYTES=5*1024*1024;
const validId=id=>typeof id==='string'&&/^[\w.-]{1,120}$/.test(id);
const same=(a,b)=>!!a&&!!b&&a.exists===b.exists&&(a.data??null)===(b.data??null);

export async function readState(file){
  try{
    const stat=await fs.stat(file);
    if(!stat.isFile())return {exists:true,tracked:false,data:null};
    if(stat.size>MAX_TRACKED_BYTES)return {exists:true,tracked:false,data:null};
    return {exists:true,tracked:true,data:(await fs.readFile(file)).toString('base64')};
  }catch(error){
    return error.code==='ENOENT'?{exists:false,tracked:true,data:null}:{exists:true,tracked:false,data:null};
  }
}

const lineCount=data=>{
  if(!data)return 0;
  const text=Buffer.from(data,'base64').toString('utf8');
  return text?text.split('\n').length-(text.endsWith('\n')?1:0):0;
};
const binary=data=>!!data&&Buffer.from(data,'base64').includes(0);

export function createCheckpoints(dir){
  const turns=new Map(); // running turns by id
  const writes=new Map();
  const chatDir=chatId=>{if(!validId(chatId))throw new Error('Invalid chat.');return path.join(dir,chatId);};
  const fileOf=(chatId,turnId)=>{if(!validId(turnId))throw new Error('Invalid checkpoint.');return path.join(chatDir(chatId),turnId+'.json');};
  function persist(turn){
    const job=(writes.get(turn.chatId)||Promise.resolve()).then(async()=>{
      await fs.mkdir(chatDir(turn.chatId),{recursive:true});
      if(turn.discarded)await fs.rm(fileOf(turn.chatId,turn.id),{force:true});
      else await fs.writeFile(fileOf(turn.chatId,turn.id),JSON.stringify(turn));
    });
    writes.set(turn.chatId,job.catch(()=>{}));
    return job;
  }
  async function load(chatId){
    await writes.get(chatId);
    let names=[];
    try{names=await fs.readdir(chatDir(chatId));}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const list=[];
    for(const name of names.filter(n=>n.endsWith('.json')).sort()){
      const id=name.slice(0,-5);
      const running=[...turns.values()].find(t=>t.chatId===chatId&&t.id===id);
      if(running){list.push(running);continue;}
      try{list.push(JSON.parse(await fs.readFile(path.join(chatDir(chatId),name),'utf8')));}catch{}
    }
    return list;
  }
  const summary=turn=>({
    id:turn.id,startedAt:turn.startedAt,finishedAt:turn.finishedAt||null,prompt:turn.prompt,status:turn.status,commands:turn.commands||[],
    files:turn.files.map(f=>({
      path:f.path,display:turn.cwd&&!path.relative(turn.cwd,f.path).startsWith('..')&&!path.isAbsolute(path.relative(turn.cwd,f.path))?path.relative(turn.cwd,f.path):f.path,
      tracked:f.before.tracked&&(f.after?.tracked??true),created:!f.before.exists,deleted:!!f.after&&!f.after.exists,reverted:!!f.reverted,
      binary:binary(f.before.data)||binary(f.after?.data),before:lineCount(f.before.data),after:lineCount(f.after?.data),added:f.stats?.added??null,removed:f.stats?.removed??null
    }))
  });

  return {
    async begin(chatId,{prompt,cwd}){
      const id=`${Date.now().toString(36).padStart(9,'0')}-${randomBytes(4).toString('hex')}`;
      const turn={id,chatId,cwd,prompt:String(prompt||'').slice(0,200),startedAt:Date.now(),status:'running',files:[],commands:[]};
      turns.set(id,turn);
      return id;
    },
    // Only the first snapshot of a path in a turn is its "before" state.
    async snapshot(turnId,{path:file,exists,data,tracked,command}){
      const turn=turns.get(turnId);
      if(!turn)return;
      if(command){if(!turn.commands.includes(command))turn.commands.push(command);return persist(turn);}
      if(typeof file!=='string'||!path.isAbsolute(file)||turn.files.some(f=>f.path===file))return;
      const size=typeof data==='string'?Buffer.byteLength(data,'base64'):0;
      turn.files.push({path:file,before:{exists:!!exists,tracked:tracked!==false&&size<=MAX_TRACKED_BYTES,data:tracked===false||size>MAX_TRACKED_BYTES?null:(data??null)}});
      return persist(turn);
    },
    async finish(turnId){
      const turn=turns.get(turnId);
      if(!turn)return null;
      turns.delete(turnId);
      for(const file of turn.files){
        file.after=await readState(file.path);
        if(file.before.tracked&&file.after.tracked&&!binary(file.before.data)&&!binary(file.after.data)){
          const text=data=>data?Buffer.from(data,'base64').toString('utf8'):'';
          file.stats=countChanges(diffLines(text(file.before.data),text(file.after.data)));
        }
      }
      turn.files=turn.files.filter(f=>!same(f.before,f.after)||!f.before.tracked||!f.after.tracked);
      turn.status='done';turn.finishedAt=Date.now();
      turn.discarded=!turn.files.length&&!turn.commands.length;
      await persist(turn);
      return turn.discarded?null:summary(turn);
    },
    async list(chatId){return (await load(chatId)).map(summary).reverse();},
    async file(chatId,turnId,file){
      const turn=(await load(chatId)).find(t=>t.id===turnId);
      const entry=turn?.files.find(f=>f.path===file);
      if(!entry)throw new Error('This change is not available.');
      const after=entry.after||await readState(entry.path);
      return {path:entry.path,before:entry.before,after};
    },
    // Restores files to before turnId, also undoing later turns that touched them.
    async restore(chatId,turnId,{file:only,force=false}={}){
      const all=await load(chatId);
      const index=all.findIndex(t=>t.id===turnId);
      if(index<0)throw new Error('This checkpoint is not available.');
      if(all.some(t=>t.status==='running'))throw new Error('Wait for the response to finish.');
      const later=all.slice(index).filter(t=>t.status!=='undone');
      const plan=new Map();
      for(const turn of later)for(const entry of turn.files){
        if(entry.reverted||(only&&entry.path!==only))continue;
        const item=plan.get(entry.path)||{path:entry.path,before:entry.before,entries:[]};
        item.after=entry.after;item.entries.push(entry);
        plan.set(entry.path,item);
      }
      if(only&&!plan.size)throw new Error('This file has no changes to revert.');
      const skipped=[],conflicts=[],ready=[];
      for(const item of plan.values()){
        if(!item.before.tracked||!item.after?.tracked){skipped.push(item.path);continue;}
        const current=await readState(item.path);
        if(!same(current,item.after))conflicts.push(item.path);
        ready.push(item);
      }
      if(conflicts.length&&!force)return {restored:[],skipped,conflicts,needsConfirmation:true};
      const restored=[];
      for(const item of ready){
        if(item.before.exists){
          await fs.mkdir(path.dirname(item.path),{recursive:true});
          await fs.writeFile(item.path,Buffer.from(item.before.data||'','base64'));
        }else await fs.rm(item.path,{force:true});
        for(const entry of item.entries)entry.reverted=true;
        restored.push(item.path);
      }
      for(const turn of later){
        if(!only||turn.files.every(f=>f.reverted||!f.before.tracked))turn.status='undone';
        await persist(turn);
      }
      return {restored,skipped,conflicts:[],needsConfirmation:false};
    },
    async remove(chatId,trash){
      await writes.get(chatId);
      for(const [id,turn] of turns)if(turn.chatId===chatId)turns.delete(id);
      await fs.mkdir(trash,{recursive:true});
      await fs.rename(chatDir(chatId),path.join(trash,'checkpoints')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
  };
}
