// Terminal tab: run commands in the chat's folder and watch the agent's commands live.
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store={get(key){try{return localStorage.getItem(key);}catch{return null;}},set(key,value){try{localStorage.setItem(key,value);}catch{}}};
const ANSI=/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const MAX_TEXT=200*1024;

// Removes color codes and applies carriage returns so progress bars redraw in place.
export function cleanOutput(text){
  return String(text).replace(ANSI,'').replace(/\r\n/g,'\n').split('\n').map(line=>line.includes('\r')?line.slice(line.lastIndexOf('\r',line.length-2)+1).replace(/\r$/,''):line).join('\n');
}
const seconds=ms=>ms<1000?(ms/1000).toFixed(1)+'s':ms<60000?Math.round(ms/100)/10+'s':Math.floor(ms/60000)+'m '+Math.round(ms%60000/1000)+'s';

export function initTerminalPanel({api,toast,currentChat,abortAgent}){
  const output=$('#terminal-output'),input=$('#terminal-command');
  let chatId=null,ticket=0;
  const entries=new Map(); // id -> {entry, raw, node}
  let history=[];try{history=JSON.parse(store.get('joltdesk-terminal-history'))||[];}catch{}
  let historyIndex=history.length,draft='';

  const atBottom=()=>output.scrollHeight-output.scrollTop-output.clientHeight<24;
  function status(entry){
    const time=entry.endedAt?seconds(entry.endedAt-entry.startedAt):'';
    if(entry.status==='running')return '<span class="spinner" aria-label="Running"></span>';
    if(entry.status==='stopped')return `<span class="term-stopped">stopped${time?' · '+time:''}</span>`;
    if(entry.status==='failed')return `<span class="term-failed">exit ${entry.exitCode??'?'}${time?' · '+time:''}</span>`;
    return `<span class="term-done">✓${time?' '+time:''}</span>`;
  }
  function head(item){
    const {entry}=item;
    item.node.className=`term-entry ${entry.status} ${entry.source}`;
    item.node.querySelector('.term-head').innerHTML=`<span class="term-src" title="${entry.source==='agent'?'Run by the agent':'Run by you'}">${entry.source==='agent'?'ϟ':'❯'}</span><code class="term-cmd" title="${esc(entry.cwd)}">${esc(entry.command)}</code><span class="term-status">${status(entry)}</span>${entry.status==='running'?`<button type="button" class="change-action" data-stop title="${entry.source==='agent'?'Stop the agent':'Stop this command (Ctrl C)'}">Stop</button>`:''}`;
    const stdin=item.node.querySelector('.term-stdin');
    if(entry.status==='running'&&entry.source==='you'&&!stdin)item.node.insertAdjacentHTML('beforeend','<form class="term-stdin"><input placeholder="Send input to this command…" aria-label="Input for this command" autocomplete="off" spellcheck="false"></form>');
    if(entry.status!=='running'&&stdin)stdin.remove();
  }
  function paint(item){
    const follow=atBottom();
    const text=cleanOutput(item.raw);
    const out=item.node.querySelector('.term-out');
    out.textContent=text;out.hidden=!text;
    if(follow)output.scrollTop=output.scrollHeight;
  }
  function add(entry){
    $('.terminal-empty')?.remove();
    const node=document.createElement('div');node.dataset.id=entry.id;
    node.innerHTML='<div class="term-head"></div><pre class="term-out" hidden></pre>';
    const item={entry,raw:entry.output||'',node};
    entries.set(entry.id,item);
    const follow=atBottom();
    output.append(node);head(item);paint(item);
    if(follow||entry.source==='you')output.scrollTop=output.scrollHeight;
  }
  function counts(){
    const running=[...entries.values()].filter(i=>i.entry.status==='running').length;
    $('#terminal-count').hidden=!running;$('#terminal-count').textContent=running?String(running):'';
  }
  function setCwd(cwd,shell){
    $('#terminal-cwd').textContent=cwd||'';$('#terminal-cwd').title=cwd||'';
    if(shell)$('#terminal-shell').textContent=shell;
  }
  function empty(text){output.innerHTML=`<p class="inspector-empty terminal-empty">${esc(text)}</p>`;}

  async function refresh(){
    const chat=currentChat();
    if(chat?.id===chatId&&entries.size)return;
    chatId=chat?.id||null;entries.clear();
    if(!chatId){setCwd('');empty('Open a conversation to use its terminal.');counts();return;}
    const mine=++ticket,id=chatId;
    // Events that arrive while the snapshot loads are held, then applied on top of it,
    // so a command started during the load is not wiped by the older snapshot.
    held=[];
    try{
      const state=await api(`/chats/${id}/terminal`);
      if(mine!==ticket||id!==chatId)return;
      output.innerHTML='';entries.clear();
      setCwd(state.cwd,state.shell);
      if(!state.entries.length)empty('Commands you run here, and commands the agent runs, appear with live output.');
      for(const entry of state.entries)add(entry);
      const known=new Set(state.entries.map(entry=>entry.id));
      const pending=held;held=null;
      // Output for entries already in the snapshot is included there; replay the rest.
      for(const e of pending)if(e.op!=='output'&&e.op!=='replace'||!known.has(e.id))event(e);
      output.scrollTop=output.scrollHeight;
      counts();
    }catch(error){if(mine===ticket){held=null;empty(error.message);}}
  }

  let held=null;
  function event(e){
    if(!chatId||chatId!==currentChat()?.id)return;
    if(held){held.push(e);return;}
    if(e.op==='start'){if(!entries.has(e.entry.id))add(e.entry);}
    else if(e.op==='output'||e.op==='replace'){
      const item=entries.get(e.id);if(!item)return;
      item.raw=e.op==='replace'?e.text:(item.raw+e.text).slice(-MAX_TEXT);
      paint(item);
    }else if(e.op==='end'){
      const item=entries.get(e.entry.id);if(!item)return;
      item.entry={...e.entry};item.raw=e.entry.output;head(item);paint(item);
    }else if(e.op==='clear'){
      for(const [id,item] of entries)if(!e.keep.includes(id)){item.node.remove();entries.delete(id);}
      if(!entries.size)empty('Commands you run here, and commands the agent runs, appear with live output.');
    }else if(e.op==='cwd')setCwd(e.cwd);
    counts();
  }

  async function stop(id){
    const item=entries.get(id);if(!item)return;
    if(item.entry.source==='agent'){abortAgent();return;}
    try{await api(`/chats/${chatId}/terminal/${encodeURIComponent(id)}/stop`,{});}catch(error){toast(error.message);}
  }
  const latestRunning=()=>[...entries.values()].reverse().find(i=>i.entry.status==='running'&&i.entry.source==='you');

  $('#terminal-form').onsubmit=async event=>{
    event.preventDefault();
    const command=input.value.trim();
    if(!command)return;
    if(!chatId){toast('Open a conversation first.');return;}
    if(history.at(-1)!==command){history.push(command);history=history.slice(-100);store.set('joltdesk-terminal-history',JSON.stringify(history));}
    historyIndex=history.length;draft='';input.value='';
    try{await api(`/chats/${chatId}/terminal/run`,{command});}
    catch(error){toast(error.message);input.value=command;}
  };
  input.addEventListener('keydown',event=>{
    if(event.key==='ArrowUp'||event.key==='ArrowDown'){
      if(!history.length)return;
      event.preventDefault();
      if(historyIndex===history.length)draft=input.value;
      historyIndex=Math.max(0,Math.min(history.length,historyIndex+(event.key==='ArrowUp'?-1:1)));
      input.value=historyIndex===history.length?draft:history[historyIndex];
      input.setSelectionRange(input.value.length,input.value.length);
    }
    if(event.ctrlKey&&event.key.toLowerCase()==='c'&&!input.selectionStart&&input.selectionEnd===input.selectionStart&&!input.value){const item=latestRunning();if(item){event.preventDefault();stop(item.entry.id);}}
    if(event.ctrlKey&&event.key.toLowerCase()==='l'){event.preventDefault();$('#terminal-clear').click();}
  });
  output.addEventListener('click',event=>{
    const button=event.target.closest('[data-stop]');
    if(button)stop(button.closest('.term-entry').dataset.id);
  });
  output.addEventListener('submit',async event=>{
    const form=event.target.closest('.term-stdin');if(!form)return;
    event.preventDefault();
    const field=form.querySelector('input'),id=form.closest('.term-entry').dataset.id;
    try{await api(`/chats/${chatId}/terminal/${encodeURIComponent(id)}/input`,{text:field.value});field.value='';}
    catch(error){toast(error.message);}
  });
  $('#terminal-clear').onclick=async()=>{if(chatId)try{await api(`/chats/${chatId}/terminal/clear`,{});}catch(error){toast(error.message);}};
  window.addEventListener('panelmodechange',e=>{if(e.detail==='terminal'){refresh();setTimeout(()=>input.focus(),0);}});

  return {refresh,event};
}
