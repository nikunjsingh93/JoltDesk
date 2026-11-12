import { randomUUID } from 'node:crypto';
import { createWorkerWorktree, inspectWorkerWorktree, workerBase } from './worker-worktrees.mjs';

// Each slot identifies one saved connection and model. Callers supply the runner
// and status transport so this module does not own credentials or UI state.
export async function delegateTasks({cwd,worktreeRoot,slots,tasks,mode='questions',runWorker,onStatus=()=>{},signal}){
  if(!['questions','coding'].includes(mode))throw new Error('Choose questions or coding for the worker tasks.');
  if(!Array.isArray(slots)||!slots.length)throw new Error('Configure at least one worker model.');
  if(!Array.isArray(tasks)||!tasks.length||tasks.length>slots.length)throw new Error('Provide one task per available worker.');
  if(tasks.some(t=>typeof t!=='string'))throw new Error('Each worker task must be text.');
  const descriptions=tasks.map(t=>t.trim());
  if(descriptions.some(t=>!t||t.length>12000))throw new Error('Each worker task must be between 1 and 12,000 characters.');
  const base=mode==='coding'?await workerBase(cwd,{requireClean:true}):null;
  const results=await Promise.all(descriptions.map(async(task,index)=>{
    let worktree;
    try{
      if(signal?.aborted)throw new Error('Worker cancelled.');
      onStatus({index,state:'preparing',task:task.slice(0,300),model:slots[index].model});
      worktree=mode==='coding'?await createWorkerWorktree({cwd,worktreeRoot,base}):{id:randomUUID()};
      if(signal?.aborted)throw new Error('Worker cancelled.');
      onStatus({index,state:'running',worktree:worktree.path});
      const answer=await runWorker({slot:slots[index],task,worktree,index,signal,mode});
      const changes=mode==='coding'?await inspectWorkerWorktree(worktree):null;
      onStatus({index,state:'done',worktree:worktree.path});
      return {index,task,slot:slots[index],mode,worktree:worktree.path,head:worktree.head,answer,changes};
    }catch(error){
      onStatus({index,state:'error',message:error.message,worktree:worktree?.path});
      return {index,task,slot:slots[index],mode,error:error.message,worktree:worktree?.path};
    }
  }));
  return results;
}
