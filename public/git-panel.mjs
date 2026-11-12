// Git tab: status of the chat's repository, file diffs, commit and push.
import {diffView} from './diff.mjs';
import {panelMode} from './side-panel.mjs';

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=ms=>{const s=Math.max(0,(Date.now()-ms)/1000);return s<60?'just now':s<3600?Math.floor(s/60)+' min ago':s<86400?Math.floor(s/3600)+' h ago':Math.floor(s/86400)+' d ago';};

export function initGitPanel({api,toast,currentChat,isRunning}){
  let state=null,chatId=null,error='',loading=0,busy='';
  const unselected=new Set(),open=new Set(),diffs=new Map();
  const message=$('#git-message');

  async function refresh(){
    const chat=currentChat();
    if(chat?.id!==chatId){chatId=chat?.id||null;state=null;error='';unselected.clear();open.clear();diffs.clear();message.value='';}
    if(!chatId){render();return;}
    const ticket=++loading,id=chatId;
    try{
      const next=await api(`/chats/${id}/git`);
      if(ticket!==loading||id!==chatId)return;
      state=next;error='';diffs.clear();
      for(const file of [...open])if(!state.files?.some(f=>f.path===file))open.delete(file);
      for(const file of [...unselected])if(!state.files?.some(f=>f.path===file))unselected.delete(file);
      render();
      for(const file of open)loadDiff(file);
    }catch(e){if(ticket===loading){error=e.message;render();}}
  }

  function render(){
    const count=state?.repo?state.files.length:0;
    $('#git-count').hidden=!count;$('#git-count').textContent=count?String(count):'';
    const empty=text=>{$('#git-head').innerHTML='';$('#git-body').hidden=true;$('#git-empty').hidden=false;$('#git-empty').textContent=text;};
    if(!chatId)return empty('Open a conversation to see its project’s Git status.');
    if(error)return empty(error);
    if(!state)return empty('Reading Git status…');
    if(!state.repo)return empty('This chat’s folder is not a Git repository. Add a project folder that uses Git to commit from here.');
    $('#git-empty').hidden=true;$('#git-body').hidden=false;
    const running=isRunning();
    const sync=state.upstream?`<span title="${esc(state.upstream)}">${state.ahead?`↑${state.ahead}`:''}${state.behind?` ↓${state.behind}`:''}${!state.ahead&&!state.behind?'up to date':''}</span>`:state.remotes.length?'<span>not published</span>':'<span>no remote</span>';
    const canPush=!state.detached&&!state.unborn&&(state.upstream?state.ahead>0:state.remotes.length>0);
    $('#git-head').innerHTML=`<div class="git-branch"><strong title="${esc(state.root)}">⎇ ${esc(state.branch||'HEAD')}</strong>${state.detached?'<i>detached</i>':''}${state.unborn?'<i>no commits yet</i>':''}<small>${sync}</small></div>
      <div class="git-head-actions"><button type="button" class="change-action" data-git="refresh" title="Refresh">↻</button><button type="button" class="change-action" data-git="push" ${canPush&&!busy?'':'disabled'} title="${state.upstream?'Push commits to '+esc(state.upstream):'Publish this branch'}">${busy==='push'?'Pushing…':state.upstream?'Push':'Publish'}</button></div>`;
    $('#git-file-count').textContent=count?`(${count})`:'';
    const chosen=state.files.filter(f=>!unselected.has(f.path));
    $('#git-select-all').checked=count>0&&chosen.length===count;
    $('#git-select-all').indeterminate=chosen.length>0&&chosen.length<count;
    $('#git-select-all').disabled=!count;
    $('#git-files').innerHTML=count?state.files.map(f=>{
      const expanded=open.has(f.path),stats=diffs.get(f.path)?.stats;
      return `<div class="change-file git-file" data-path="${esc(f.path)}">
        <div class="change-file-row"><input type="checkbox" data-select aria-label="Include ${esc(f.path)}" ${unselected.has(f.path)?'':'checked'}>
        <button type="button" class="change-file-name" data-toggle aria-expanded="${expanded}" title="${esc(f.from?f.from+' → '+f.path:f.path)}"><span class="caret">${expanded?'▾':'▸'}</span><span>${esc(f.path)}</span></button>
        <span class="change-stats">${stats?`<b class="plus">+${stats.added}</b> <b class="minus">−${stats.removed}</b>`:''}<i class="git-code git-${f.code==='?'?'new':esc(f.code)}" title="${esc(f.label)}">${f.code==='?'?'U':f.code==='U'?'!':esc(f.code)}</i></span></div>
        ${expanded?`<div class="change-diff">${diffs.get(f.path)?.html||'<p class="inspector-empty">Loading diff…</p>'}</div>`:''}</div>`;
    }).join(''):'<p class="inspector-empty">No changes. Your working tree is clean.</p>';
    $('#git-write').disabled=!chosen.length||!!busy;
    $('#git-write').textContent=busy==='message'?'Writing…':'✨ Write message';
    $('#git-commit').disabled=!chosen.length||!!busy||running;
    $('#git-commit').textContent=busy==='commit'?'Committing…':`Commit ${chosen.length||''} file${chosen.length===1?'':'s'}`.replace('  ',' ');
    $('#git-commit').title=running?'Wait for the response to finish before committing.':'';
    $('#git-commits').innerHTML=state.commits.length?state.commits.map(c=>`<div class="git-commit-row" title="${esc(c.hash)}"><code>${esc(c.short)}</code><span>${esc(c.subject)}</span><small>${esc(c.author)} · ${ago(c.time)}</small></div>`).join(''):'<p class="inspector-empty">No commits yet.</p>';
  }

  async function loadDiff(file){
    try{
      const result=await api(`/chats/${chatId}/git/file?path=${encodeURIComponent(file)}`);
      diffs.set(file,diffView(result.before,result.after));
    }catch(e){diffs.set(file,{html:`<p class="inspector-empty">${esc(e.message)}</p>`});}
    if(open.has(file))render();
  }

  const selectedPaths=()=>state.files.filter(f=>!unselected.has(f.path)).map(f=>f.path);
  async function action(kind,task){
    if(busy)return;
    busy=kind;render();
    try{await task();}catch(e){toast(e.message);}
    finally{busy='';await refresh();}
  }

  $('#git-files').addEventListener('click',event=>{
    const row=event.target.closest('.git-file');if(!row)return;
    const file=row.dataset.path;
    if(event.target.closest('[data-select]')){if(event.target.checked)unselected.delete(file);else unselected.add(file);render();return;}
    if(event.target.closest('[data-toggle]')){if(open.has(file))open.delete(file);else{open.add(file);if(!diffs.has(file))loadDiff(file);}render();}
  });
  $('#git-select-all').onchange=event=>{unselected.clear();if(!event.target.checked)for(const f of state.files)unselected.add(f.path);render();};
  $('#git-head').addEventListener('click',event=>{
    const button=event.target.closest('[data-git]');if(!button)return;
    if(button.dataset.git==='refresh')refresh();
    if(button.dataset.git==='push')action('push',async()=>{
      const result=await api(`/chats/${chatId}/git/push`,{});
      toast(state.upstream?'Pushed to '+state.upstream+'.':'Branch published.'+(result.output?'':''));
    });
  });
  $('#git-write').onclick=()=>action('message',async()=>{
    const result=await api(`/chats/${chatId}/git/message`,{paths:selectedPaths()});
    message.value=result.message;message.focus();
  });
  $('#git-commit').onclick=()=>{
    if(!message.value.trim()){toast('Write a commit message first.');message.focus();return;}
    action('commit',async()=>{
      const result=await api(`/chats/${chatId}/git/commit`,{message:message.value,paths:selectedPaths()});
      message.value='';unselected.clear();
      toast(`Committed ${result.short}: ${result.subject}`);
    });
  };
  message.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$('#git-commit').click();}});
  window.addEventListener('panelmodechange',()=>{if(panelMode()==='git')refresh();});
  window.addEventListener('focus',()=>{if(panelMode()==='git'&&document.body.classList.contains('inspector-open'))refresh();});

  return {refresh};
}
