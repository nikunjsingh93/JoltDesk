// Changes tab: per-request file diffs recorded by the server, with undo.
import {diffView} from './diff.mjs';
import {panelMode} from './side-panel.mjs';

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=ms=>{const date=new Date(ms);return date.toDateString()===new Date().toDateString()?date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):date.toLocaleDateString([],{month:'short',day:'numeric'})+' '+date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});};

export function initChangesPanel({api,toast,currentChat,isRunning}){
  const list=$('#changes-list'),count=$('#changes-count');
  let turns=[],chatId=null,loading=0;
  const open=new Set(); // `${turn}\n${path}` of expanded files
  const diffs=new Map();

  async function refresh(){
    const chat=currentChat();
    if(chat?.id!==chatId){chatId=chat?.id||null;turns=[];open.clear();diffs.clear();}
    if(!chatId){render();return;}
    const ticket=++loading,id=chatId;
    try{
      const result=await api(`/chats/${id}/checkpoints`);
      if(ticket!==loading||id!==chatId)return;
      turns=result.turns;
      for(const key of [...diffs.keys()])if(!turns.some(t=>key.startsWith(t.id+'\n')))diffs.delete(key);
      // Diffs of the newest request may change while it runs; reload expanded ones.
      for(const key of open){const [turn]=key.split('\n');if(turns[0]?.id===turn)diffs.delete(key);}
      render();
      for(const key of open)if(!diffs.has(key))loadDiff(key);
    }catch(error){if(ticket===loading){list.innerHTML=`<p class="inspector-empty">${esc(error.message)}</p>`;}}
  }

  function render(){
    const active=turns.filter(t=>t.status!=='undone'&&t.files.some(f=>!f.reverted)).length;
    count.hidden=!active;count.textContent=active?String(active):'';
    if(!chatId){list.innerHTML='<p class="inspector-empty">Open a conversation to see the changes its agent makes.</p>';return;}
    if(!turns.length){list.innerHTML='<p class="inspector-empty">File edits made by the agent appear here, grouped by request, with an option to undo them.</p>';return;}
    const running=isRunning();
    list.innerHTML=turns.map(turn=>{
      const undone=turn.status==='undone',live=turn.status==='running';
      const files=turn.files.map(file=>{
        const key=turn.id+'\n'+file.path,expanded=open.has(key),stats=diffs.get(key)?.stats||(file.added!=null?{added:file.added,removed:file.removed}:null);
        const tags=[file.created&&'new',file.deleted&&'deleted',file.binary&&'binary',!file.tracked&&'not tracked',file.reverted&&'reverted'].filter(Boolean);
        return `<div class="change-file ${file.reverted?'reverted':''}" data-key="${esc(key)}">
          <div class="change-file-row"><button type="button" class="change-file-name" data-toggle aria-expanded="${expanded}" title="${esc(file.path)}"><span class="caret">${expanded?'▾':'▸'}</span><span>${esc(file.display)}</span></button>
          <span class="change-stats">${stats?`<b class="plus">+${stats.added}</b> <b class="minus">−${stats.removed}</b>`:''}${tags.map(t=>`<i>${t}</i>`).join('')}</span>
          ${!undone&&!live&&!file.reverted&&file.tracked?`<button type="button" class="change-action" data-revert title="Restore this file to before this request" ${running?'disabled':''}>Revert</button>`:''}</div>
          ${expanded?`<div class="change-diff">${diffs.get(key)?.html||'<p class="inspector-empty">Loading diff…</p>'}</div>`:''}
        </div>`;
      }).join('');
      const commands=turn.commands.length?`<p class="change-note">Ran ${esc(turn.commands.join(' and '))}. Files changed by commands are not tracked.</p>`:'';
      return `<section class="change-turn ${undone?'undone':''}" data-turn="${esc(turn.id)}">
        <div class="change-turn-head"><div><strong title="${esc(turn.prompt)}">${esc(turn.prompt||'Request')}</strong><small>${when(turn.startedAt)} · ${turn.files.length} file${turn.files.length===1?'':'s'}${undone?' · undone':live?' · running':''}</small></div>
        ${!undone&&!live&&turn.files.some(f=>f.tracked&&!f.reverted)?`<button type="button" class="change-action" data-undo title="Restore files to before this request" ${running?'disabled':''}>Undo</button>`:''}</div>
        ${files}${commands}</section>`;
    }).join('');
  }

  async function loadDiff(key){
    const [turn,file]=key.split('\n');
    try{
      const result=await api(`/chats/${chatId}/checkpoints/${encodeURIComponent(turn)}/file?path=${encodeURIComponent(file)}`);
      diffs.set(key,diffView(result.before,result.after));
    }catch(error){diffs.set(key,{html:`<p class="inspector-empty">${esc(error.message)}</p>`});}
    if(open.has(key))render();
  }

  // Shows the confirmation dialog and resolves to true when the user confirms.
  function confirmUndo({title,message,files,action}){
    const dialog=$('#undo-dialog');
    $('#undo-title').textContent=title;$('#undo-message').textContent=message;
    $('#undo-files').innerHTML=files.map(f=>`<li>${esc(f)}</li>`).join('');
    $('#undo-confirm').textContent=action;
    return new Promise(resolve=>{
      const finish=value=>{dialog.removeEventListener('close',onClose);$('#undo-confirm').onclick=null;$('#undo-cancel').onclick=null;if(dialog.open)dialog.close();resolve(value);};
      const onClose=()=>finish(false);
      dialog.addEventListener('close',onClose);
      $('#undo-confirm').onclick=()=>finish(true);
      $('#undo-cancel').onclick=()=>finish(false);
      dialog.showModal();
    });
  }

  async function restore(turnId,file){
    const turn=turns.find(t=>t.id===turnId);
    const index=turns.indexOf(turn);
    const later=turns.slice(0,index).filter(t=>t.status!=='undone'&&t.files.some(f=>!f.reverted&&(!file||f.path===file)));
    const affected=[...new Set([turn,...later].flatMap(t=>t.files.filter(f=>f.tracked&&!f.reverted&&(!file||f.path===file)).map(f=>f.display)))];
    const note=later.length?` Edits from ${later.length} later request${later.length===1?'':'s'} to ${affected.length===1?'this file':'these files'} are undone too.`:'';
    const ok=await confirmUndo({title:file?'Revert file?':'Undo this request?',message:`Restore ${affected.length===1?'this file':'these files'} to how ${affected.length===1?'it was':'they were'} before “${turn.prompt||'this request'}”.${note} Changes made by commands are not undone.`,files:affected,action:file?'Revert file':'Undo changes'});
    if(!ok)return;
    try{
      let result=await api(`/chats/${chatId}/checkpoints/${encodeURIComponent(turnId)}/restore`,{path:file});
      if(result.needsConfirmation){
        const force=await confirmUndo({title:'Files changed since',message:'These files were changed after the agent edited them. Undoing will discard those changes.',files:result.conflicts,action:'Discard and undo'});
        if(!force)return;
        result=await api(`/chats/${chatId}/checkpoints/${encodeURIComponent(turnId)}/restore`,{path:file,force:true});
      }
      toast(`Restored ${result.restored.length} file${result.restored.length===1?'':'s'}.`+(result.skipped.length?` ${result.skipped.length} could not be restored.`:'')+' The agent will be told on your next message.');
    }catch(error){toast(error.message);}
    await refresh();
  }

  list.addEventListener('click',event=>{
    const fileNode=event.target.closest('.change-file'),turnNode=event.target.closest('.change-turn');
    if(event.target.closest('[data-toggle]')&&fileNode){
      const key=fileNode.dataset.key;
      if(open.has(key))open.delete(key);else{open.add(key);if(!diffs.has(key))loadDiff(key);}
      render();return;
    }
    if(event.target.closest('[data-revert]')&&fileNode){restore(turnNode.dataset.turn,fileNode.dataset.key.split('\n')[1]);return;}
    if(event.target.closest('[data-undo]')&&turnNode)restore(turnNode.dataset.turn);
  });
  window.addEventListener('panelmodechange',()=>{if(panelMode()==='changes')refresh();});

  return {refresh,render};
}
