import {displayMetrics,elapsedText} from './reply-metrics.mjs';
import {partialStringField,readableArguments} from './stream-content.mjs';
import {initBrowserPanel} from './browser-panel.mjs';
import {initSidePanel,panelMode} from './side-panel.mjs';
import {initChangesPanel} from './changes-panel.mjs';
import {initGitPanel} from './git-panel.mjs';
import {initInstructions} from './instructions.mjs';
import {initTerminalPanel} from './terminal-panel.mjs';
import {initSkills} from './skills-panel.mjs';
import {makeRuntime,reduceBackground,trackTool,collectInspector,updateThinking} from './chat-runtime.mjs';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let config, current, projectId=null, ws, files=[], messages=[], streaming=null, running=false, started=0, chars=0, usage={}, stats={}, approval, generation=0, finalSeconds=0,followChat=true;
const toolNodes=new Map();
const chatStates=new Map();
let promptTotal=0;
let changesPanel=null,gitPanel=null,instructionsPanel=null,terminalPanel=null,skillsPanel=null;
function saveCurrentState(){if(!current)return;const s=chatStates.get(current.id);if(!s)return;Object.assign(s,{chat:current,messages,streaming,running,started,chars,usage,stats,finalSeconds,ws,files,draft:$('#prompt').value,followChat,stage:$('#activity-text').textContent,approval});}
function parkActivity(){const activity=$('#activity');if(activity)$('#activity-parking').append(activity);}
function mountActivity(message){
  const activity=$('#activity');
  if(!message?.el||activity.parentElement===message.el)return;
  activity.classList.add('reply-activity');
  message.el.insertBefore(activity,message.el.querySelector('.blocks'));
}
function paintThinking(message,el){const ms=message.live?Number(message.thinkingDurationMs||0)+(message.isThinking?Math.max(0,performance.now()-(message.thinkingTickAt||performance.now())):0):message.replyMetrics?.thinkingMs??message.thinkingDurationMs;for(const span of el?.querySelectorAll('.thinking-duration')||[])span.textContent=elapsedText(ms);for(const spinner of el?.querySelectorAll('.thinking-spinner')||[])spinner.classList.toggle('hidden',!message.live||!message.isThinking);if(message===streaming&&message.isThinking&&el?.querySelector('.thinking-box'))$('#activity').classList.add('hidden');}
let projectExpansion={};try{projectExpansion=JSON.parse(localStorage.getItem('bolt-project-expansion'))||{};}catch{}
const saveProjectExpansion=()=>{try{localStorage.setItem('bolt-project-expansion',JSON.stringify(projectExpansion));}catch{}};
async function api(url,data,method=data?'POST':'GET'){
  const r=await fetch('/api'+url,{method,headers:{'Content-Type':'application/json','X-Bolt-Token':window.BOLT_TOKEN},body:data?JSON.stringify(data):undefined});
  const result=await r.json();if(!r.ok)throw new Error(result.error||'Request failed');return result;
}
function toast(text){$('#toast').textContent=text;$('#toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.add('hidden'),6500);}
function markdown(text,options={}){return DOMPurify.sanitize(marked.parse(text||'',options),{FORBID_TAGS:['img'],FORBID_ATTR:['style','id','name']});}
function enhance(el){
  el.querySelectorAll('a').forEach(a=>{a.target='_blank';a.rel='noopener noreferrer';});
  el.querySelectorAll('pre').forEach(pre=>{if(pre.querySelector('.code-top'))return;const code=pre.querySelector('code');if(!code)return;
    const top=document.createElement('div');top.className='code-top';top.innerHTML=`<span>${esc(code.className.replace('language-','')||'code')}</span><button>Copy</button>`;
    if(window.hljs){try{window.hljs.highlightElement(code);}catch{}}
    top.querySelector('button').onclick=async e=>{try{await navigator.clipboard.writeText(code.textContent);e.target.textContent='Copied';}catch{toast('Clipboard is unavailable. Select and copy the code.');}};pre.prepend(top);
  });
}
function renderSidebar(){
  $('#chat-menu').hidePopover();
  const query=$('#search').value.trim().toLowerCase();
  const chatRow=c=>{const s=chatStates.get(c.id),busy=s?s.running:config.runningChats?.includes(c.id);return `<div class="chat-row ${current?.id===c.id?'selected':''}"><button class="open-chat" data-id="${c.id}"><span class="chat-marker ${busy?'busy':''}" title="${s?.approval?'Needs approval':busy?'Generating in background':''}">${s?.approval?'◇':busy?'◌':'◌'}</span><span>${esc(c.title)}</span></button><button class="chat-actions" data-id="${c.id}" aria-label="Chat options: ${esc(c.title)}" aria-haspopup="menu" aria-controls="chat-menu" aria-expanded="false" title="Rename or delete chat">⋯</button></div>`;};
  $('#projects').innerHTML=config.projects.map(p=>{
    const nameMatch=query&&p.name.toLowerCase().includes(query),chats=config.chats.filter(c=>c.projectId===p.id&&(!query||nameMatch||c.title.toLowerCase().includes(query)));
    if(query&&!nameMatch&&!chats.length)return '';
    const expanded=!!query||(projectExpansion[p.id]??projectId===p.id);
    return `<section class="project-tree" data-project-id="${p.id}"><div class="project-heading ${projectId===p.id?'selected':''}"><button class="project-toggle" data-id="${p.id}" aria-label="${expanded?'Collapse':'Expand'} ${esc(p.name)}" aria-expanded="${expanded}" aria-controls="project-chats-${p.id}">${expanded?'⌄':'›'}</button><button class="open-project" data-id="${p.id}" title="${esc(p.path)}">▱ <span>${esc(p.name)}</span></button><button class="project-new-chat" data-id="${p.id}" aria-label="New chat in ${esc(p.name)}" title="New chat in this project">＋</button><button class="project-actions" data-id="${p.id}" aria-label="Project options: ${esc(p.name)}" aria-haspopup="menu" aria-controls="project-menu" aria-expanded="false" title="Project options">⋯</button></div><div id="project-chats-${p.id}" class="project-chats" role="group" aria-label="Chats in ${esc(p.name)}" ${expanded?'':'hidden'}>${chats.map(chatRow).join('')||'<div class="empty-project">No chats yet</div>'}</div></section>`;
  }).join('')||(!config.projects.length?'<div class="empty-side">Add a project to group chats.</div>':'');
  $('#projects').querySelectorAll('.project-toggle').forEach(b=>b.onclick=()=>{projectExpansion[b.dataset.id]=b.getAttribute('aria-expanded')!=='true';saveProjectExpansion();renderSidebar();});
  $('#projects').querySelectorAll('.open-project').forEach(b=>b.onclick=()=>{saveCurrentState();generation++;projectId=b.dataset.id;projectExpansion[projectId]=true;saveProjectExpansion();current=null;messages=[];streaming=null;stats={};ws=null;running=false;approval=null;$('#approval-dialog').close();renderSidebar();renderChat();setRunning(false);});
  $('#projects').querySelectorAll('.project-new-chat').forEach(b=>b.onclick=()=>newChat(b.dataset.id));
  $('#projects').querySelectorAll('.project-actions').forEach(b=>b.onclick=()=>{
    const menu=$('#project-menu');if(menu.matches(':popover-open')&&editingProjectId===b.dataset.id){menu.hidePopover();return;}
    projectMenuTrigger?.setAttribute('aria-expanded','false');menu.hidePopover();editingProjectId=b.dataset.id;projectMenuTrigger=b;menu.showPopover();
    const r=b.getBoundingClientRect(),box=menu.getBoundingClientRect();
    menu.style.left=Math.max(8,Math.min(r.right-box.width,innerWidth-box.width-8))+'px';
    menu.style.top=Math.max(8,r.bottom+box.height+8>innerHeight?r.top-box.height-4:r.bottom+4)+'px';
    b.setAttribute('aria-expanded','true');$('#remove-project').focus();
  });
  const chats=config.chats.filter(c=>!c.projectId&&c.title.toLowerCase().includes(query));
  $('#chat-count').textContent=chats.length;$('#chats').innerHTML=chats.map(chatRow).join('')||`<div class="empty-side">${query?'No matching general conversations.':'Your general conversations appear here.'}</div>`;
  $('.sidebar-navigation').querySelectorAll('.open-chat').forEach(b=>b.onclick=()=>openChat(config.chats.find(c=>c.id===b.dataset.id)));
  $('.sidebar-navigation').querySelectorAll('.chat-actions').forEach(b=>b.onclick=()=>{
    const menu=$('#chat-menu');if(menu.matches(':popover-open')&&editingChatId===b.dataset.id){menu.hidePopover();return;}
    chatMenuTrigger?.setAttribute('aria-expanded','false');menu.hidePopover();editingChatId=b.dataset.id;chatMenuTrigger=b;menu.showPopover();
    const r=b.getBoundingClientRect(),box=menu.getBoundingClientRect();
    menu.style.left=Math.max(8,Math.min(r.right-box.width,innerWidth-box.width-8))+'px';
    menu.style.top=Math.max(8,r.bottom+box.height+8>innerHeight?r.top-box.height-4:r.bottom+4)+'px';
    b.setAttribute('aria-expanded','true');$('#rename-chat').focus();
  });
  $('#project-label').textContent=config.projects.find(p=>p.id===projectId)?.name||'Personal workspace';
}
function renderModels(){
  const sections=(config.connections||[]).filter(c=>c.models?.length);
  $('#model').innerHTML=sections.length?sections.map(c=>`<optgroup label="${esc(c.name)}">${c.models.map(m=>`<option data-connection-id="${c.id}" data-model-id="${esc(m.id)}" value="${esc(c.id===config.connection?.id?m.id:c.id+'::'+m.id)}">${esc(m.name||m.id)}</option>`).join('')}</optgroup>`).join(''):config.models.length?config.models.map(m=>`<option value="${esc(m.id)}">${esc(m.name||m.id)}</option>`).join(''):'<option value="">Connect a model</option>';
  if(current?.model&&config.models.some(m=>m.id===current.model)&&(!current.connectionId||current.connectionId===config.connection?.id))$('#model').value=current.model;
  // A chat bound to another (possibly offline) API shows its own model, so choosing any other model switches it.
  else if(current?.connectionId&&current.connectionId!==config.connection?.id&&[...$('#model').options].some(o=>o.value===current.connectionId+'::'+current.model))$('#model').value=current.connectionId+'::'+current.model;
  else if(config.preferredModel&&config.models.some(m=>m.id===config.preferredModel))$('#model').value=config.preferredModel;
  else if(config.models.length)$('#model').value=config.models[0].id;
  $('#connection-label').textContent=config.connected?`${config.connection?.name||(config.connection?.provider==='local'?'Model API':'OpenAI')} · ${config.models.length} models`:'Local · ready to connect';
  $('.private-label').textContent=config.connected?(config.connection?.provider==='local'?'◉ Your model API':'◉ OpenAI API'):'◉ On your device';
  $('#welcome-connect').innerHTML='Connect a model API to get started <span>→</span>';
  $('#welcome-connect').classList.toggle('hidden',config.connected);$('#binary').value=config.customEngine||!config.engine?config.binary||'':'';
  $('#remember-label').classList.toggle('hidden',!config.secureStorage);$('#storage-note').textContent=config.secureStorage?'Saved keys are encrypted with your operating system key store.':'Session only: your key stays in server memory and is never saved to browser storage.';
  $('#browse').classList.toggle('hidden',!config.native);
  $('#web-tools-label').classList.toggle('hidden',!config.webAvailable);
  renderEngine(config.engine);
  renderConnection();
  renderThinking();
  updateMetrics();
}
function renderThinking(levels,level){
  const model=config.models.find(m=>m.id===$('#model').value);
  const capable=!!model?.reasoning;
  if(!levels)levels=capable?(model.thinkingLevelMap?Object.keys(model.thinkingLevelMap).filter(k=>model.thinkingLevelMap[k]!==null):['off','minimal','low','medium','high']):['off'];
  const supported=capable&&levels.some(l=>l!=='off');
  const previous=$('#thinking').value;
  $('#thinking').classList.toggle('hidden',!supported);$('#thinking').disabled=running||!supported;
  $('#thinking').innerHTML=levels.map(l=>`<option value="${l}">${l==='off'?'Thinking off':config.connection?.provider==='local'&&levels.length===2?'Thinking on':'Thinking · '+({minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max'}[l]||l)}</option>`).join('');
  const selected=current?.thinking||level||previous;
  $('#thinking').value=levels.includes(selected)?selected:levels.includes('medium')?'medium':levels[0];
}
let editingConnectionId=null;const connectionDrafts=new Map();
function readConnectionForm(){return {id:editingConnectionId||'',connectionId:editingConnectionId||undefined,name:$('#connection-name').value,provider:$('#provider').value,baseUrl:$('#base-url').value,profile:$('#server-profile').value,contextWindow:$('#context-window').value,maxTokens:$('#auto-output-tokens').checked||!$('#max-output-tokens').value?'auto':$('#max-output-tokens').value,thinking:$('#local-thinking').value,thinkingTokenBudget:$('#thinking-token-budget').value,key:$('#api-key').value,remember:$('#remember').checked};}
function stashConnectionDraft(force=false){if(editingConnectionId===null||(!force&&!connectionDrafts.has(editingConnectionId)))return;connectionDrafts.set(editingConnectionId,readConnectionForm());$('#connection-draft-status').textContent='Unsaved changes';}
function renderConnection(){const id=editingConnectionId??config.connection?.id??'';renderSavedConnections();fillConnection(connectionDrafts.get(id)||config.connections?.find(c=>c.id===id)||(id?config.connection:{...config.connection,id:''}));if(config.connectionError)$('#settings-feedback').textContent=config.connectionError;}
function editConnection(c,scroll=false){stashConnectionDraft();fillConnection(connectionDrafts.get(c.id||'')||c);if(scroll){$('#connection-fields').scrollIntoView({behavior:'smooth',block:'start'});$('#connection-name').focus({preventScroll:true});}}
function fillConnection(c){
  c=c||{provider:'local',maxTokens:'auto'};editingConnectionId=c.id||'';$('#connection-editor').value=editingConnectionId;$('#connection-name').value=c.name||'';$('#provider').value=c.provider||'local';$('#api-key').value=c.key||'';$('#remember').checked=c.remember??true;
  $('#base-url').value=c.baseUrl||'';$('#context-window').value=c.contextWindow||'';$('#max-output-tokens').value=c.maxTokens==='auto'?'':c.maxTokens||'';$('#auto-output-tokens').checked=c.maxTokens==='auto';$('#max-output-tokens').disabled=c.maxTokens==='auto';$('#server-profile').value=c.profile||'llamacpp';$('#local-thinking').value=c.thinking||'auto';$('#thinking-token-budget').value=c.thinkingTokenBudget??'';$('#thinking-budget-field').classList.toggle('hidden',!(c.models||config.connections?.find(p=>p.id===c.id)?.models||[]).some(m=>m.splashThinkingBudget));connectionFields();
  $('#save-connection').classList.toggle('hidden',!editingConnectionId);$('#save-connection').disabled=!editingConnectionId;$('#connect-button').innerHTML=editingConnectionId?'Reconnect & discover models <span>→</span>':'Connect & save API <span>→</span>';$('#connection-draft-status').textContent=connectionDrafts.has(editingConnectionId)?'Unsaved changes':'';
}
let removingApiId=null,renamingApiId=null;
function renderSavedConnections(){
  $('#connection-editor').innerHTML='<option value="">Add a new API</option>'+(config.connections||[]).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#connection-editor').value=editingConnectionId||'';
  $('#saved-connections').innerHTML=(config.connections||[]).map(c=>`<section data-connection-id="${c.id}" class="saved-api-card ${c.id===config.connection?.id&&config.connected?'active':''}"><div class="saved-api-title"><strong>${esc(c.name)}</strong><span class="api-status"></span>${c.id===config.connection?.id&&config.connected?'<span class="api-in-use">In use</span>':''}</div><small>${esc(c.baseUrl)}${c.recovered?' · recovered':''}</small><div class="saved-api-actions"><button type="button" data-action="use" data-id="${c.id}">${c.id===config.connection?.id&&config.connected?'Reconnect':'Use'}</button><button type="button" data-action="edit" data-id="${c.id}">Edit</button><button type="button" data-action="rename" data-id="${c.id}">Rename</button><button type="button" data-action="remove" data-id="${c.id}" class="danger">Remove</button></div>${removingApiId===c.id?`<div class="api-remove-confirm"><p>Remove this API and its saved key? Your chats will stay.</p><button type="button" data-action="cancel-remove" data-id="${c.id}">Cancel</button><button type="button" class="danger" data-action="confirm-remove" data-id="${c.id}">Remove API</button></div>`:''}</section>`).join('')||'<small>No saved APIs yet. Add your first connection below.</small>';
  paintConnectionStatuses();
}
function paintConnectionStatuses(){
  const labels={connected:'Connected',saved:'Saved',unavailable:'Unavailable','key-required':'Key required','check-key':'Check key'};
  for(const c of config.connections||[]){const badge=$(`#saved-connections [data-connection-id="${c.id}"] .api-status`);if(!badge)continue;const status=c.status||{state:'saved'};badge.textContent=labels[status.state]||'Saved';badge.dataset.state=status.state;badge.title=status.checkedAt?'Last checked '+new Date(status.checkedAt).toLocaleTimeString():'Connection will be checked when Settings opens.';}
}
let checkingApiStatuses=false;
async function refreshConnectionStatuses(){if(checkingApiStatuses||!config?.connections?.length)return;checkingApiStatuses=true;try{const result=await api('/connections/status');for(const c of config.connections||[])if(result.statuses[c.id])c.status=result.statuses[c.id];paintConnectionStatuses();}catch{}finally{checkingApiStatuses=false;}}
let apiSwitchPending=null;
async function useConnection(id,modelId){
  $('#status').textContent='Connecting API…';$('#send').disabled=true;
  const work=(async()=>{
  if(running)await newChat(null);
  config=await api(`/connections/${id}/activate`,{});const model=modelId&&config.models.some(m=>m.id===modelId)?modelId:config.preferredModel&&config.models.some(m=>m.id===config.preferredModel)?config.preferredModel:config.models[0]?.id;
  if(current)await patchChat({connectionId:id,model,thinking:'off'});
  renderModels();if(model){$('#model').value=model;await api('/model',{modelId:model});}if(current)await openChat(current);else{renderThinking();$('#status').textContent='Ready';}
  })();apiSwitchPending=work;try{await work;}finally{if(apiSwitchPending===work)apiSwitchPending=null;$('#send').disabled=false;}
}
function connectionFields(){
  const local=$('#provider').value==='local';$('#local-connection').classList.toggle('hidden',!local);$('#base-url').required=local;
  $('#api-key-label').textContent=local?'API key (optional for unauthenticated servers)':'OpenAI API key';
  $('#api-key').placeholder=local?'Leave blank if no key is required':'sk-…';
  $('#api-key-help').textContent=local?'A saved key is reused only for the same API URL. Your OpenAI key is never reused here.':'';
}
$('#provider').onchange=connectionFields;
function renderEngine(engine){
  if(!engine){$('#engine-panel').classList.add('hidden');return;}
  const wasAvailable=config.engine?.available;config.engine=engine;
  $('#engine-panel').classList.remove('hidden');$('#engine-version').textContent=engine.current.replace('bolt-v','v');
  $('#engine-source').textContent=config.customEngine?'Custom executable selected · managed updates require the built-in engine':engine.source==='bundled'?'Built in · no separate installation required':'Managed update · bundled fallback included';
  $('#engine-update-status').textContent=engine.error?engine.message+' '+engine.error:engine.message;
  $('#check-engine').disabled=engine.checking||engine.installing;
  $('#install-engine').classList.toggle('hidden',!engine.available);$('#install-engine').disabled=engine.checking||engine.installing||config.customEngine||running;
  $('#install-engine').textContent=engine.installing?'Updating…':`Install ${engine.latest?.replace('bolt-v','v')||'update'}`;
  $('#auto-engine').checked=engine.automatic;$('#auto-engine').disabled=engine.installing;
  $('#engine-progress').classList.toggle('hidden',!engine.installing);
  if(engine.total)$('#engine-progress').value=100*engine.received/engine.total;
  if(engine.available&&!wasAvailable)toast(`Pi-Bolt ${engine.latest} is available in Settings.`);
}
function atScrollEnd(body){
  return body.scrollHeight-body.clientHeight-body.scrollTop<=2;
}
function trackDetailsScroll(box,body){
  const view={body,text:null,top:0,left:0,following:true};
  view.remember=()=>{
    if(!box.open||!body.clientHeight)return;
    view.top=body.scrollTop;
    view.left=body.scrollLeft;
    view.following=atScrollEnd(body);
  };
  view.restore=()=>{
    if(!box.open||!body.clientHeight)return;
    body.scrollTop=view.following?body.scrollHeight:view.top;
    body.scrollLeft=view.left;
  };
  body.addEventListener('scroll',view.remember);
  box.addEventListener('toggle',view.restore);
  return view;
}
const thinkingViews=new WeakMap();
function renderThinkingBlock(block,box,open){
  if(!box){
    box=document.createElement('details');
    box.className='thinking-box';
    box.open=open;
    box.innerHTML='<summary><span class="thinking-label"><span class="spinner thinking-spinner hidden" aria-hidden="true"></span>Thinking</span><span class="thinking-duration"></span></summary><div class="thinking-body markdown"></div>';
    thinkingViews.set(box,trackDetailsScroll(box,box.querySelector('.thinking-body')));
  }
  const view=thinkingViews.get(box);
  const text=block.thinking||'';
  if(text!==view.text){
    view.remember();
    view.body.innerHTML=markdown(text,{breaks:true});
    enhance(view.body);
    view.text=text;
    view.restore();
  }
  return box;
}
const toolViews=new WeakMap();
// Draws image parts of a tool result, such as a browser screenshot, under its text.
function showToolImages(box,content){
  const images=(content||[]).filter(c=>c.type==='image'&&/^image\/(png|jpeg|webp|gif)$/.test(c.mimeType||'')&&typeof c.data==='string');
  box.querySelectorAll('.tool-image').forEach(img=>img.remove());
  for(const part of images){
    const img=document.createElement('img');
    img.className='tool-image';img.alt='Tool result image';img.src=`data:${part.mimeType};base64,${part.data}`;
    box.append(img);
  }
}
const fileLanguages={html:'html',htm:'html',js:'javascript',ts:'typescript',py:'python',css:'css',json:'json',md:'markdown'};
function renderToolBlock(block,box,open){
  if(!box){
    box=document.createElement('details');
    box.className='tool';
    box.open=open;
    box.innerHTML='<summary></summary><pre class="tool-stream-body"></pre>';
    toolViews.set(box,trackDetailsScroll(box,box.querySelector('pre')));
  }
  const args=block.argumentText||'';
  const path=block.arguments?.path||partialStringField(args,'path');
  const content=block.arguments?.content??partialStringField(args,'content');
  // Written files stream as code. Other tools show their arguments decoded, so code inside
  // an edit appears line by line instead of as one long escaped JSON string.
  const text=(block.name==='write'&&content?content:readableArguments(args||JSON.stringify(block.arguments||{})))||'';
  const language=block.name==='write'?(fileLanguages[path.split('.').at(-1)]||''):'yaml';
  const summary=box.querySelector('summary');
  const label=`⌘ ${block.name}${path?' · '+path:''}${block.isStreaming?' · generating…':''}`;
  if(summary.textContent!==label)summary.textContent=label;

  const view=toolViews.get(box);
  if(view.text!==text||view.language!==language){
    view.remember();
    const code=document.createElement('code');
    if(language)code.className='language-'+language;
    code.textContent=text;
    view.body.replaceChildren(code);
    enhance(box);
    view.text=text;
    view.language=language;
    view.restore();
  }
  return box;
}
const answerText=new WeakMap();
function updateAnswerChildren(container,next){
  const incoming=[...next.childNodes];
  for(const [index,child] of incoming.entries()){
    const old=container.childNodes[index];
    if(!old){container.append(child);continue;}
    if(old.isEqualNode(child))continue;
    if(old.nodeName===child.nodeName&&old.nodeName==='PRE'){
      const top=old.scrollTop,left=old.scrollLeft,following=atScrollEnd(old);
      old.replaceChildren(...child.childNodes);
      old.scrollTop=following?old.scrollHeight:top;
      old.scrollLeft=left;
    }else if(old.nodeName===child.nodeName&&old.querySelector?.('pre')&&child.querySelector?.('pre')){
      for(const attribute of [...old.attributes])if(!child.hasAttribute(attribute.name))old.removeAttribute(attribute.name);
      for(const attribute of child.attributes)old.setAttribute(attribute.name,attribute.value);
      updateAnswerChildren(old,child);
    }else old.replaceWith(child);
  }
  while(container.childNodes.length>incoming.length)container.lastChild.remove();
}
function renderAnswerText(text,old){
  const previous=answerText.has(old)?old:null;
  if(previous&&answerText.get(previous)===text)return previous;
  const next=document.createElement('div');
  next.className='markdown answer-markdown';
  next.innerHTML=markdown(text);
  enhance(next);
  for(const code of next.querySelectorAll('pre'))code.tabIndex=0;
  if(previous)updateAnswerChildren(previous,next);
  const node=previous||next;
  answerText.set(node,text);
  return node;
}
function renderMessageBlocks(m,blocks){
  const content=Array.isArray(m.content)?m.content:typeof m.content==='string'?[{type:'text',text:m.content}]:[];
  const existing=new Map([...blocks.children].map(node=>[Number(node.dataset.index),node]));
  for(const [index,node] of existing)if(!content[index])node.remove();
  for(const [index,block] of content.entries()){
    if(!block)continue;
    const old=existing.get(index);
    let node;
    if(block.type==='text'){
      if(m.role==='assistant')node=renderAnswerText(block.text,old);
      else{node=document.createElement('div');node.className='markdown';node.innerHTML=markdown(block.text);enhance(node);}
    }
    if(block.type==='thinking')node=renderThinkingBlock(block,thinkingViews.has(old)?old:null,!!m.live);
    if(block.type==='image'){node=document.createElement('p');node.textContent='▧ Image attached';}
    if(block.type==='toolCall')node=renderToolBlock(block,toolViews.has(old)?old:null,!!m.live);
    if(!node){old?.remove();continue;}
    if(node===old)continue;
    node.dataset.index=index;
    if(old)old.replaceWith(node);
    else blocks.insertBefore(node,[...blocks.children].find(child=>Number(child.dataset.index)>index)||null);
  }
  return content;
}
function originalPrompt(m){
  if(typeof m.promptText==='string')return {text:m.promptText,attachments:!!m.hasAttachments};
  const raw=typeof m.content==='string'?m.content:(m.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n');
  const marker=raw.search(/\n\n(?:<attached_file\b|This attachment is (?:a saved copy|the user’s file) at )/);
  return {text:(marker<0?raw:raw.slice(0,marker)).trim(),attachments:marker>=0||(m.content||[]).some?.(c=>c.type==='image')};
}
function messageNode(m,el=document.createElement('article')){
  if(!el.firstElementChild){
    el.className='message '+m.role;
    el.innerHTML=`<div class="message-head"><span class="avatar">${m.role==='user'?'N':'<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 2 4 14h7l-1 8L20 9h-7l.5-7Z"/></svg>'}</span>${m.role==='user'?'You':'JoltDesk'}<span class="message-model" style="color:var(--muted);font-size:10px;font-weight:400"></span></div><div class="blocks"></div>`;
  }
  if(m.role==='user'&&!el.querySelector('.prompt-actions')){
    const actions=document.createElement('div');actions.className='prompt-actions';
    actions.innerHTML='<button type="button" data-prompt-action="copy" title="Copy prompt">Copy</button><button type="button" data-prompt-action="edit" title="Edit and send again">Edit</button>';
    actions.querySelector('[data-prompt-action="copy"]').onclick=async()=>{try{await navigator.clipboard.writeText(originalPrompt(m).text);toast('Prompt copied.');}catch{toast('Clipboard is unavailable. Select and copy the prompt.');}};
    actions.querySelector('[data-prompt-action="edit"]').onclick=async()=>{
      const prompt=originalPrompt(m),draft=$('#prompt').value;
      if(draft.trim()&&draft!==prompt.text&&!await confirmAction({title:'Replace draft?',message:'Your current draft will be replaced by this earlier prompt.',confirm:'Replace draft'}))return;
      $('#prompt').value=prompt.text;$('#prompt').focus();saveCurrentState();
      if(prompt.attachments)toast('Prompt copied to the composer. Reattach its files before sending.');
    };
    el.append(actions);
  }
  const model=el.querySelector('.message-model');
  if(model.textContent!==(m.model||''))model.textContent=m.model||'';
  model.hidden=!m.model;
  const content=renderMessageBlocks(m,el.querySelector('.blocks'));
  let row=el.querySelector('.reply-metrics');
  if(m.role==='assistant'&&!row){
    row=document.createElement('div');
    row.className='reply-metrics';
    row.innerHTML='<span data-stat="speed"></span><span data-stat="tokens"></span><span data-stat="time"></span><span data-stat="cost"></span>';
    el.append(row);
  }
  el.querySelector(':scope > .reply-error')?.remove();
  el.querySelector(':scope > .output-limit-notice')?.remove();
  if(m.errorMessage&&m.stopReason!=='aborted'){const p=document.createElement('p');p.className='reply-error';p.textContent=m.errorMessage;p.style.color='#e5ab91';el.insertBefore(p,row);}
  if(m.stopReason==='length'){const notice=document.createElement('div');notice.className='output-limit-notice';notice.textContent='Output limit reached'+(content.some(b=>b?.type==='thinking')&&!content.some(b=>b?.type==='text'&&b.text?.trim())?' while thinking. No final answer was produced.':' before the reply was complete.')+(m.replyMetrics?.outputLimit==='auto'?' The server applied its own limit. Set a larger explicit output limit, or send “Continue”.':' Use Auto output or a larger limit, then send “Continue”.');el.insertBefore(notice,row);}
  if(row)paintReplyMetrics(m,el);
  paintThinking(m,el);return el;
}
function paintReplyMetrics(m,el){
  const row=el?.querySelector('.reply-metrics');if(!row)return;
  const metric=displayMetrics(m,performance.now());
  row.querySelector('[data-stat="speed"]').textContent=metric.rate!==null?`${metric.rateEstimated?'~':''}${metric.rate.toFixed(1)} tok/s`:m.live?'Measuring…':'';
  row.querySelector('[data-stat="speed"]').title=metric.rateEstimated?'Estimated generation speed from the first streamed thinking, text or tool token. Excludes initial waiting and prompt processing.':'Server-reported generation speed, including thinking and answer tokens. Excludes waiting and prompt processing.';
  row.querySelector('[data-stat="tokens"]').textContent=metric.output?`${metric.estimated?'~':''}${metric.output.toLocaleString()} ${metric.estimated?'est. ':''}tokens`:m.live?'Waiting for tokens…':'0 tokens';
  row.querySelector('[data-stat="time"]').textContent=elapsedText(metric.durationMs);
  row.querySelector('[data-stat="time"]').title='Elapsed time since this prompt was sent, including tool calls and model requests.';
  row.querySelector('[data-stat="cost"]').textContent=metric.costText;
  row.classList.toggle('live',!!m.live);
}
function renderChat(){
  parkActivity();$('#welcome').classList.toggle('hidden',messages.length>0);$('#messages').replaceChildren();toolNodes.clear();
  for(const m of messages){if(['user','assistant'].includes(m.role)){m.el=messageNode(m);$('#messages').append(m.el);}else if(m.role==='toolResult'){
    const d=document.createElement('details');d.className='tool';d.innerHTML=`<summary>↳ ${esc(m.toolName||'Tool result')}</summary><pre>${esc((m.content||[]).map(c=>c.text||'').join('\n'))}</pre>`;showToolImages(d,m.content);$('#messages').append(d);
  }}
  $('#chat-title').textContent=current?.title||'New conversation';$('#permission').value=current?.mode||'chat';$('#permission').classList.toggle('bypass',current?.mode==='bypass');
  $('#web-tools').checked=!!current?.webEnabled;
  $('#file-menu').hidePopover();
  renderModels();
  if(streaming)mountActivity(streaming);else if(running)mountActivity(messages.findLast(m=>m.role==='assistant'));renderInspector();changesPanel?.refresh();gitPanel?.refresh();instructionsPanel?.refresh();terminalPanel?.refresh();skillsPanel?.refresh();
}
function scrollBottom(){const area=$('#scroll-area');if(followChat)area.scrollTop=area.scrollHeight;}
$('#scroll-area').addEventListener('scroll',e=>{followChat=atScrollEnd(e.currentTarget);});
function setRunning(value,save=true){if(running&&!value)finalSeconds=(performance.now()-started)/1000;const changed=running!==value;running=value;$('#activity').classList.toggle('hidden',!value);$('#send').textContent=value?'■':'↑';$('#send').classList.toggle('running',value);$('#send').title=value?'Stop this reply':'Send message';$('#model').disabled=value;$('#thinking').disabled=value;$('#web-tools').disabled=value;$('#status').textContent=value?'Working':'Ready';if(value&&changed){started=performance.now();chars=0;usage={};finalSeconds=0;$('#activity-text').textContent='Waiting for model…';}if(streaming)mountActivity(streaming);updateMetrics();if(save)saveCurrentState();}
function updateMetrics(){
  $('#activity').classList.toggle('hidden',!running||!!(streaming?.isThinking&&streaming.el?.querySelector('.thinking-box')));
  const seconds=running?(performance.now()-started)/1000:finalSeconds,estimated=!usage.output&&running,output=usage.output|| (running?Math.ceil(chars/4):stats.tokens?.output||0);
  if(streaming?.el){paintReplyMetrics(streaming,streaming.el);paintThinking(streaming,streaming.el);}
  const thinkingMs=streaming?.isThinking?Number(streaming.thinkingDurationMs||0)+Math.max(0,performance.now()-(streaming.thinkingTickAt||performance.now())):null;
  $('#elapsed').textContent=elapsedText(thinkingMs??seconds*1000);
  // An estimated limit is not shown: the engine's own stats carry the same guess.
  const selectedModel=config?.models.find(m=>m.id===$('#model').value),c=stats.contextUsage,windowSize=selectedModel?.contextWindowEstimated?null:selectedModel?.contextWindow||c?.contextWindow;
  const liveInput=Number(usage.input||0)+Number(usage.cacheRead||0)+Number(usage.cacheWrite||0);
  // Each agent step starts a new reply with empty usage. Prefer the exact prompt size the
  // server reports, then live usage, then the previous step's total,
  // so the meter never drops to zero mid-run.
  const lastUsage=messages.findLast(m=>m.role==='assistant'&&!m.live&&m.usage)?.usage;
  const lastContext=lastUsage?Number(lastUsage.input||0)+Number(lastUsage.cacheRead||0)+Number(lastUsage.cacheWrite||0)+Number(lastUsage.output||0):null;
  const contextTokens=running?(promptTotal?promptTotal+output:liveInput?liveInput+output:(lastContext||c?.tokens||0)+output):(c?.tokens||lastContext)??(!current?0:null);
  const percent=windowSize?100*(contextTokens||0)/windowSize:0;
  $('#context').textContent=windowSize&&contextTokens!=null?`Context ${running&&!liveInput?'~':''}${Number(contextTokens).toLocaleString()} / ${Number(windowSize).toLocaleString()} · ${percent.toFixed(1)}%`:windowSize?`Context — / ${Number(windowSize).toLocaleString()}`:contextTokens?`Context ${Number(contextTokens).toLocaleString()}`:'Context —';
  $('#context').title=windowSize?'':'The server has not reported this model’s context limit yet.';
  $('#context-fill').style.width=percent+'%';
}
setInterval(()=>{if(running)updateMetrics();},200);
async function newChat(targetProjectId=projectId){try{saveCurrentState();const chat=await api('/chats',{projectId:targetProjectId,model:$('#model').value,webEnabled:!current&&$('#web-tools').checked});config.chats.unshift(chat);await openChat(chat);}catch(e){toast(e.message);}}
async function openChat(chat){
  saveCurrentState();const seq=++generation;current=chat;projectId=chat.projectId||null;if(projectId){projectExpansion[projectId]=true;saveProjectExpansion();}messages=[];streaming=null;stats={};running=false;ws=null;approval=null;$('#approval-dialog').close();$('#prompt').value='';files=[];renderFiles();renderSidebar();renderChat();setRunning(false,false);
  try{
    // A chat still opens when its API is offline, so it can be read or moved to a working API.
    let offline=null;
    if(chat.connectionId&&chat.connectionId!==config.connection?.id){const saved=(config.connections||[]).find(c=>c.id===chat.connectionId);if(!saved)offline={kind:'removed'};else{try{config=await api(`/connections/${chat.connectionId}/activate`,{});}catch(error){offline={kind:'api',api:saved.name,message:error.message};}}if(seq!==generation)return;}
    let s=chatStates.get(chat.id);if(s?.loading){await s.ready;if(seq===generation)restoreChatState(s);return;}if(s?.loaded&&s.ws?.readyState===1){restoreChatState(s);return;}
    s=makeRuntime(chat);s.loading=true;s.ready=new Promise(resolve=>s.resolveReady=resolve);s.queue=[];chatStates.set(chat.id,s);
    const socket=new WebSocket(`${location.origin.replace('http','ws')}/stream?chat=${chat.id}&token=${encodeURIComponent(window.BOLT_TOKEN)}`);s.ws=socket;ws=socket;
    socket.onmessage=message=>{const e=JSON.parse(message.data);if(s.loading){s.queue.push(e);return;}deliverChatEvent(s,e);};
    socket.onopen=()=>{socket.send(JSON.stringify({type:'levels'}));if(current?.id===chat.id&&!s.loading)$('#status').textContent='Pi-Bolt connected';};
    socket.onclose=()=>{s.running=false;if(current?.id===chat.id){setRunning(false);$('#status').textContent='Connection closed · reopen chat to reconnect';}renderSidebar();};
    await new Promise((resolve,reject)=>{if(socket.readyState===1)resolve();else{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(new Error('Could not connect to this chat.')),{once:true});}});
    const history=await api(`/chats/${chat.id}/history`);s.messages=history.messages.map(m=>({...m,replyMetrics:history.replyMetrics?.[m.timestamp]}));s.stats=history.stats;s.running=!!(history.busy||history.state?.isStreaming);s.approval=history.approval;
    if(history.live){s.streaming={...history.live,startedAt:performance.now()-history.live.elapsedMs,turnStartedAt:performance.now()-(history.live.turnElapsedMs??history.live.elapsedMs),thinkingTickAt:performance.now()};if(history.live.firstDeltaMs!=null)s.streaming.generationStartedAt=s.streaming.startedAt+history.live.firstDeltaMs;const i=s.messages.findIndex(m=>m.role==='assistant'&&m.timestamp===s.streaming.timestamp);if(i>=0)s.messages[i]=s.streaming;else s.messages.push(s.streaming);s.stage=s.streaming.isThinking?'Thinking…':'Writing a response…';}
    s.offline=offline||history.offline||null;
    s.started=s.streaming?.turnStartedAt??performance.now();s.loaded=true;s.loading=false;for(const e of s.queue)if(e.seq==null||e.seq>history.sequence)reduceBackground(s,e);s.queue=[];s.resolveReady();
    if(seq===generation){restoreChatState(s);if(s.offline)showOffline(s.offline);}
  }catch(e){toast(e.message);$('#status').textContent='Engine needs attention';}
}
function showOffline(info){
  if(info.kind==='api'){toast(`${info.api} is not reachable. You can read this chat. Pick a model from a working API to continue.`);$('#status').textContent=`${info.api} offline`;}
  else if(info.kind==='removed'){toast('This chat’s API was removed. You can read this chat. Pick a model to continue.');$('#status').textContent='API removed';}
  else{toast(`This chat could not start: ${info.message} Showing the saved conversation. Pick a model to continue.`);$('#status').textContent='Read-only';}
}
function restoreChatState(s){promptTotal=0;current=s.chat;messages=s.messages;streaming=s.streaming;running=s.running;started=s.started;chars=s.chars;usage=s.usage;stats=s.stats;finalSeconds=s.finalSeconds;ws=s.ws;files=s.files;followChat=s.followChat;approval=s.approval;$('#prompt').value=s.draft||'';$('#activity-text').textContent=s.stage;renderFiles();renderSidebar();renderChat();setRunning(s.running);$('#activity-text').textContent=s.stage;$('#status').textContent=s.running?(s.stage?.startsWith('Thinking')?'Generating':s.stage):'Pi-Bolt connected';if(approval)showApproval(approval);scrollBottom();document.body.classList.remove('sidebar-open');}
function deliverChatEvent(s,e){
  if(e.type==='config_changed'){api('/config').then(next=>{config=next;renderModels();updateMetrics();}).catch(()=>{});return;}
  if(e.type==='chat_updated'){const c=config.chats.find(c=>c.id===s.chat.id);if(c)Object.assign(c,e.chat);}
  if(current?.id===s.chat.id){trackTool(s,e);onEvent(e);saveCurrentState();if(['checkpoints_changed','agent_start','agent_settled'].includes(e.type))changesPanel?.refresh();if(['agent_start','agent_settled'].includes(e.type))gitPanel?.refresh();if(e.type==='terminal')terminalPanel?.event(e);if(['tool_execution_start','tool_execution_end','message_end','agent_settled'].includes(e.type))renderInspector();}
  else reduceBackground(s,e);
  if(['agent_start','agent_settled','chat_updated','extension_ui_request','approval_resolved','app_error','engine_closed'].includes(e.type))renderSidebar();
}
function streamingBlock(index,type){
  if(!streaming){streaming={role:'assistant',content:[],model:$('#model').value,live:true,startedAt:performance.now()};messages.push(streaming);streaming.el=messageNode(streaming);$('#messages').append(streaming.el);}
  if(!streaming.content[index]){streaming.content[index]={type,...(type==='thinking'?{thinking:''}:{text:''})};}
  return streaming.content[index];
}
let renderScheduled=false;
function updateStreamNode(m){
  followChat=followChat&&atScrollEnd($('#scroll-area'));
  messageNode(m,m.el);
  mountActivity(m);
  scrollBottom();
}
function renderStream(){if(renderScheduled)return;renderScheduled=true;setTimeout(()=>{renderScheduled=false;if(streaming?.el)updateStreamNode(streaming);},55);}
function onEvent(e){
  if(e.type==='generation_timing'&&streaming){streaming.serverTimings=e.timings;paintReplyMetrics(streaming,streaming.el);}
  if(e.type==='model_loading'&&running&&!chars){$('#activity-text').textContent=e.loading?'Loading model…':'Processing request · awaiting streamed tokens…';$('#status').textContent=e.loading?'Loading model':'Processing';}
  if(e.type==='prompt_progress'&&e.total>0){promptTotal=Number(e.total);updateMetrics();}
  if(e.type==='prompt_progress'&&running&&!chars&&e.total>0){
    const done=Math.min(e.total,Number(e.processed||0)),percent=Math.floor(100*done/e.total);
    $('#activity-text').textContent=`Processing prompt · ${percent}% (${done.toLocaleString()} / ${Number(e.total).toLocaleString()} tokens${e.cache?`, ${Number(e.cache).toLocaleString()} cached`:''})`;
    $('#status').textContent=`Processing ${percent}%`;
  }
  if(e.type==='generation_start'){
    promptTotal=0;
    streaming={role:'assistant',content:[],model:e.model||$('#model').value,live:true,placeholder:true,startedAt:performance.now()-(e.elapsedMs||0),turnStartedAt:performance.now()-(e.turnElapsedMs||0)};chars=0;usage={};messages.push(streaming);streaming.el=messageNode(streaming);$('#messages').append(streaming.el);$('#activity-text').textContent='Processing request · awaiting streamed tokens…';$('#status').textContent='Processing';scrollBottom();
    mountActivity(streaming);$('#activity').classList.remove('hidden');
  }
  if(e.type==='message_start'&&e.message?.role==='assistant'){
    if(streaming?.placeholder){Object.assign(streaming,e.message,{placeholder:false,live:true});updateStreamNode(streaming);}
    else{streaming={...e.message,content:[],live:true,startedAt:performance.now()-(e.timing?.elapsedMs||0)};chars=0;usage={};messages.push(streaming);streaming.el=messageNode(streaming);$('#messages').append(streaming.el);}
  }
  if(e.type==='message_update'){
    const a=e.assistantMessageEvent;if(e.usage){usage=e.usage;if(streaming)streaming.usage=e.usage;}
    updateThinking(streaming,e.timing,performance.now());
    if(streaming&&e.timing?.elapsedMs!==undefined)streaming.startedAt=Math.min(streaming.startedAt,performance.now()-e.timing.elapsedMs);
    if(streaming&&e.timing?.firstDeltaMs!==null&&e.timing?.firstDeltaMs!==undefined)streaming.generationStartedAt=streaming.startedAt+e.timing.firstDeltaMs;
    if(['text_delta','thinking_delta'].includes(a.type)){const think=a.type==='thinking_delta',block=streamingBlock(a.contentIndex,think?'thinking':'text');block[think?'thinking':'text']+=a.delta;chars+=a.delta.length;$('#activity-text').textContent=think?'Thinking…':'Writing a response…';$('#status').textContent=think?'Generating':'Writing';renderStream();}
    if(['text_end','thinking_end'].includes(a.type)){const think=a.type==='thinking_end',block=streamingBlock(a.contentIndex,think?'thinking':'text');block[think?'thinking':'text']=a.content;renderStream();}
    if(a.type==='toolcall_start'){streamingBlock(a.contentIndex,'toolCall');streaming.content[a.contentIndex]={type:'toolCall',name:a.toolName,id:a.id,arguments:{},argumentText:'',isStreaming:true};$('#activity-text').textContent=`Preparing ${a.toolName}…`;$('#status').textContent='Preparing tool';renderStream();}
    if(a.type==='toolcall_delta'){const block=streamingBlock(a.contentIndex,'toolCall');block.argumentText=(block.argumentText||'')+a.delta;chars+=a.delta.length;$('#activity-text').textContent=block.name==='write'?'Writing file content…':`Preparing ${block.name||'tool'}…`;$('#status').textContent='Writing';renderStream();}
    if(a.type==='toolcall_end'){streamingBlock(a.contentIndex,'toolCall');streaming.content[a.contentIndex]={...a.toolCall,isStreaming:false};renderStream();}
    updateMetrics();
  }
  if(e.type==='message_end'&&e.message?.role==='assistant'){
    rememberPrefill(e.replyMetrics?.serverTimings);
    usage=e.message.usage||usage;
    if(streaming?.el){Object.assign(streaming,e.message,{live:false,isThinking:false,replyMetrics:e.replyMetrics});updateStreamNode(streaming);}
    else{const m={...e.message,replyMetrics:e.replyMetrics};messages.push(m);$('#messages').append(messageNode(m));}streaming=null;$('#activity-text').textContent=e.message.stopReason==='toolUse'?'Preparing tools…':'Finishing…';scrollBottom();
  }
  if(e.type==='message_end'&&e.message?.role==='toolResult')messages.push(e.message);
  if(e.type==='tool_execution_start'){
    $('#activity-text').textContent=`Running ${e.toolName}…`;const d=document.createElement('details');d.open=true;d.className='tool';d.innerHTML=`<summary>⌘ ${esc(e.toolName)} · running</summary><pre></pre>`;d.querySelector('pre').textContent=JSON.stringify(e.args,null,2);toolNodes.set(e.toolCallId,d);$('#messages').append(d);scrollBottom();
  }
  if(['tool_execution_update','tool_execution_end'].includes(e.type)){
    const d=toolNodes.get(e.toolCallId);if(d){const result=e.result||e.partialResult;d.querySelector('pre').textContent=(result?.content||[]).map(c=>c.text||'').join('\n');showToolImages(d,result?.content);if(e.type==='tool_execution_end'){d.querySelector('summary').textContent=`${e.isError?'✕':'✓'} ${e.toolName} · ${e.durationMs!=null?(e.durationMs/1000).toFixed(2)+'s':'finished'}`;d.open=false;}}scrollBottom();
  }
  if(e.type==='agent_settled'){setRunning(false);streaming=null;$('#status').textContent=messages.findLast(m=>m.role==='assistant')?.stopReason==='aborted'?'Stopped':'Response complete';}
  if(e.type==='agent_start'&&!running)setRunning(true);
  if(e.type==='stats'){stats=e.data;updateMetrics();}
  if(e.type==='chat_updated'){Object.assign(current,e.chat);$('#chat-title').textContent=current.title;renderSidebar();}
  if(e.type==='model_state'){
    renderThinking(e.levels,e.state.thinkingLevel);
  }
  if(e.type==='permission_changed'){if(current)current.mode=e.mode;$('#permission').value=e.mode;$('#permission').classList.toggle('bypass',e.mode==='bypass');$('#permission').title='Active tools: '+(e.tools.join(', ')||'none');}
  if(e.type==='approval_resolved'){$('#approval-dialog').close();approval=null;}
  if(e.type==='compaction_start'){$('#status').textContent='Compacting context…';$('#activity-text').textContent='Compacting context…';}
  if(e.type==='compaction_end'){$('#status').textContent=e.errorMessage||'Context compacted';}
  if(e.type==='auto_retry_start')$('#activity-text').textContent=`Retry ${e.attempt}/${e.maxAttempts} · ${e.errorMessage}`;
  if(e.type==='extension_ui_request')showApproval(e);
  if(e.type==='engine_status')renderEngine(e.engine);
  if(e.type==='engine_updated'){config.models=e.models;config.engine=e.engine;renderModels();toast('Pi-Bolt updated. Reopen your conversation to reconnect.');}
  if(['app_error','engine_closed'].includes(e.type)){if(streaming){streaming.live=false;streaming.isThinking=false;updateStreamNode(streaming);}setRunning(false);streaming=null;toast(e.message);$('#status').textContent='Attention needed';}
}
function showApproval(e){
  if(e.method==='notify'){toast(e.message);return;}if(!['confirm','select','input','editor'].includes(e.method))return;
  approval=e;$('#approval-title').textContent=e.title||'Pi-Bolt needs input';$('#approval-content').textContent=e.message||'';$('#approval-options').replaceChildren();
  if(e.method==='select'){const s=document.createElement('select');s.id='approval-value';e.options.forEach(o=>{const opt=document.createElement('option');opt.value=o;opt.textContent=o;s.append(opt);});$('#approval-options').append(s);}
  if(['input','editor'].includes(e.method)){const input=document.createElement(e.method==='editor'?'textarea':'input');input.id='approval-value';input.value=e.prefill||'';input.placeholder=e.placeholder||'';$('#approval-options').append(input);}
  $('#approval-dialog').showModal();
}
function answerApproval(allow){if(approval&&ws?.readyState===1)ws.send(JSON.stringify({type:'ui_response',id:approval.id,confirmed:allow,cancelled:!allow,value:$('#approval-value')?.value}));approval=null;saveCurrentState();$('#approval-dialog').close();}
$('#allow').onclick=()=>answerApproval(true);$('#deny').onclick=()=>answerApproval(false);$('#approval-dialog').addEventListener('cancel',e=>{e.preventDefault();answerApproval(false);});
async function send(){
  if(apiSwitchPending){try{await apiSwitchPending;}catch(e){toast(e.message);return;}}
  if(running){ws?.send(JSON.stringify({type:'abort'}));$('#activity-text').textContent='Stopping…';return;}
  if(!config.connected){$('#settings-dialog').showModal();return;}
  const text=$('#prompt').value.trim();if(!text&&!files.length)return;
  if(!current){await newChat();if(ws?.readyState===0)await new Promise(resolve=>{const timer=setTimeout(resolve,10000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});});}
  if(!ws||ws.readyState!==1){toast('Connecting to Pi-Bolt. Try sending again in a moment.');return;}
  try{
    // Refuse images for a text-only model before sending, and keep the message and files.
    const images=files.filter(f=>/^image\//.test(f.type));
    const chosen=$('#model').selectedOptions[0],connectionId=chosen?.dataset.connectionId||current?.connectionId||config.connection?.id;
    const modelId=chosen?.dataset.modelId||$('#model').value;
    const modelInfo=(config.connections||[]).find(c=>c.id===connectionId)?.models?.find(m=>m.id===modelId)||config.models.find(m=>m.id===modelId);
    if(images.length&&modelInfo&&!modelInfo.input?.includes('image')){toast(`${modelInfo.name||modelInfo.id} does not accept images. Choose a vision model, or remove the image to send text only. Your message is still in the box.`);return;}
    await patchChat({model:$('#model').value,thinking:$('#thinking').value,webEnabled:$('#web-tools').checked});
    const attached=[...files];const display=text+(attached.length?'\n\n'+attached.map(f=>'📎 '+f.name).join('\n'):'');
    const m={role:'user',promptText:text,hasAttachments:!!attached.length,content:[{type:'text',text:display}]};messages.push(m);$('#welcome').classList.add('hidden');$('#messages').append(messageNode(m));
    $('#prompt').value='';files=[];renderFiles();followChat=true;setRunning(true);ws.send(JSON.stringify({type:'prompt',message:text,files:attached}));scrollBottom();
  }catch(e){toast(e.message);}
}
async function patchChat(data){if(!current)return;const chat=current,updated=await api(`/chats/${chat.id}`,data,'PATCH');Object.assign(chat,updated);const listed=config.chats.find(c=>c.id===chat.id);if(listed)Object.assign(listed,updated);}
$('#send').onclick=send;$('#prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
$('#new-chat').onclick=$('#add-conversation').onclick=()=>newChat(null);$('#search').oninput=renderSidebar;
$('#settings').onclick=$('#welcome-connect').onclick=()=>{$('#settings-dialog').showModal();refreshEngine();};
$('#settings-dialog').addEventListener('toggle',e=>{if(e.newState==='open')refreshConnectionStatuses();});
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
let settingsBackdrop=false;
const settingsDialog=$('#settings-dialog');
const outsideSettings=e=>{const r=settingsDialog.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};
settingsDialog.addEventListener('pointerdown',e=>{settingsBackdrop=e.target===settingsDialog&&outsideSettings(e);});
settingsDialog.addEventListener('click',e=>{if(settingsBackdrop&&e.target===settingsDialog&&outsideSettings(e))settingsDialog.close();settingsBackdrop=false;});
let editingChatId=null,chatMenuTrigger=null,editingProjectId=null,projectMenuTrigger=null;
$('#project-menu').addEventListener('toggle',e=>{if(e.newState==='closed')projectMenuTrigger?.setAttribute('aria-expanded','false');});
$('#remove-project').onclick=()=>{
  $('#project-menu').hidePopover();
  const project=config.projects.find(p=>p.id===editingProjectId);if(!project)return;
  const count=config.chats.filter(c=>c.projectId===project.id).length;
  $('#remove-project-name').textContent=project.name;
  $('#remove-project-path').textContent=project.path;
  $('#remove-project-chats').textContent=count?`Its ${count} chat${count===1?' is':'s are'} deleted too.`:'';
  $('#remove-project-feedback').textContent='';
  $('#remove-project-dialog').showModal();$('#cancel-remove-project').focus();
};
$('#cancel-remove-project').onclick=()=>$('#remove-project-dialog').close();
$('#confirm-remove-project').onclick=async()=>{
  const id=editingProjectId,button=$('#confirm-remove-project');button.disabled=true;
  try{
    const result=await api(`/projects/${id}`,{},'DELETE');
    config.projects=config.projects.filter(p=>p.id!==id);
    config.chats=config.chats.filter(c=>!result.chats.includes(c.id));
    for(const chatId of result.chats){chatStates.get(chatId)?.ws?.close();chatStates.delete(chatId);}
    delete projectExpansion[id];saveProjectExpansion();
    if(projectId===id)projectId=null;
    if(current&&result.chats.includes(current.id)){generation++;ws=null;current=null;messages=[];streaming=null;stats={};setRunning(false);renderChat();updateMetrics();}
    renderSidebar();$('#remove-project-dialog').close();toast('Project removed. Its folder was not changed.');
  }catch(e){$('#remove-project-feedback').textContent=e.message;}
  finally{button.disabled=false;}
};
$('#chat-menu').addEventListener('toggle',e=>{if(e.newState==='closed')chatMenuTrigger?.setAttribute('aria-expanded','false');});
$('#chat-menu').addEventListener('keydown',e=>{const items=[...$('#chat-menu').querySelectorAll('[role=menuitem]')];if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const i=items.indexOf(document.activeElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowUp'?-1:1)+items.length)%items.length].focus();}if(e.key==='Escape'){e.preventDefault();$('#chat-menu').hidePopover();chatMenuTrigger?.focus();}});
const closeChatMenu=()=>$('#chat-menu').hidePopover();
$('.sidebar-navigation').addEventListener('scroll',closeChatMenu);window.addEventListener('resize',closeChatMenu);
$('#rename-chat').onclick=()=>{closeChatMenu();const chat=config.chats.find(c=>c.id===editingChatId);if(!chat)return;$('#rename-chat-title').value=chat.title;$('#chat-actions-feedback').textContent='';$('#chat-actions-dialog').showModal();$('#rename-chat-title').select();};
$('#rename-chat-form').onsubmit=async e=>{e.preventDefault();try{const chat=await api(`/chats/${editingChatId}`,{title:$('#rename-chat-title').value},'PATCH');Object.assign(config.chats.find(c=>c.id===chat.id),chat);if(current?.id===chat.id){Object.assign(current,chat);$('#chat-title').textContent=chat.title;}renderSidebar();$('#chat-actions-dialog').close();}catch(e){$('#chat-actions-feedback').textContent=e.message;}};
$('#delete-chat').onclick=()=>{closeChatMenu();const chat=config.chats.find(c=>c.id===editingChatId);if(!chat)return;$('#delete-chat-name').textContent=chat.title;$('#delete-chat-feedback').textContent='';$('#delete-chat-dialog').showModal();$('#cancel-delete-chat').focus();};
$('#cancel-delete-chat').onclick=()=>$('#delete-chat-dialog').close();
$('#confirm-delete-chat').onclick=async()=>{const id=editingChatId;$('#confirm-delete-chat').disabled=true;try{await api(`/chats/${id}`,{},'DELETE');config.chats=config.chats.filter(c=>c.id!==id);chatStates.get(id)?.ws?.close();chatStates.delete(id);if(current?.id===id){generation++;ws=null;current=null;messages=[];streaming=null;stats={};setRunning(false);renderChat();updateMetrics();}renderSidebar();$('#delete-chat-dialog').close();toast('Chat deleted.');}catch(e){$('#delete-chat-feedback').textContent=e.message;}finally{$('#confirm-delete-chat').disabled=false;}};
$('#connect-form').onsubmit=async e=>{e.preventDefault();const form=readConnectionForm(),saving=e.submitter?.id==='save-connection';$('#connect-button').disabled=true;$('#save-connection').disabled=true;$('#settings-feedback').textContent=saving?'Saving API settings…':'Connecting to your API and discovering models…';try{
  if(saving){if(!form.id)throw new Error('Connect and save this new API first.');config=await api(`/connections/${form.id}/settings`,form);connectionDrafts.delete(form.id);editingConnectionId=form.id;renderModels();$('#settings-feedback').textContent=`Saved changes. Max output: ${form.maxTokens==='auto'?'Auto':Number(form.maxTokens).toLocaleString()+' tokens'}.`;toast('API changes saved.');return;}
  if(running)await newChat(null);
  config=await api('/connect',form);connectionDrafts.delete(form.id);editingConnectionId=config.connection.id;$('#api-key').value='';if(current)await patchChat({connectionId:config.connection.id,model:config.models[0]?.id,thinking:'off'});renderModels();$('#settings-feedback').textContent=`Connected. ${config.models.length} compatible models ready. ${config.connectionNote||''}`;toast('Connected. Your models are ready.');$('#settings-dialog').close();if(current)await openChat(current);
}catch(e){$('#settings-feedback').textContent=e.message;}finally{$('#connect-button').disabled=false;$('#save-connection').disabled=!editingConnectionId;}};
for(const event of ['input','change'])$('#connection-fields').addEventListener(event,e=>{if(e.target.id!=='connection-editor')stashConnectionDraft(true);});
$('#save-binary').onclick=async()=>{try{config=await api('/binary',{path:$('#binary').value});renderModels();if(current)await openChat(current);toast('Executable selection saved.');}catch(e){toast(e.message);}};
$('#use-bundled').onclick=async()=>{try{config=await api('/binary',{path:''});renderModels();if(current)await openChat(current);toast('Using the built-in Pi-Bolt engine.');}catch(e){toast(e.message);}};
async function refreshEngine(){try{const e=await api('/engine');if(e)renderEngine(e);}catch{}}
$('#check-engine').onclick=async()=>{try{$('#check-engine').disabled=true;renderEngine(await api('/engine/check',{}));}catch(e){toast(e.message);$('#check-engine').disabled=false;}};
$('#auto-engine').onchange=async()=>{try{renderEngine(await api('/engine/automatic',{enabled:$('#auto-engine').checked}));}catch(e){toast(e.message);}};
$('#install-engine').onclick=async()=>{
  if(running){toast('Finish or stop your response before updating.');return;}
  $('#install-engine').disabled=true;
  try{config=await api('/engine/install',{});renderModels();if(current)await openChat(current);toast('Pi-Bolt updated and ready.');}catch(e){toast(e.message);await refreshEngine();}
};
setInterval(refreshEngine,15000);setInterval(()=>{if($('#settings-dialog').open||config?.engine?.installing)refreshEngine();},1500);
setInterval(()=>{if($('#settings-dialog').open)refreshConnectionStatuses();},30000);
$('#disconnect').onclick=async()=>{try{config=await api('/disconnect',{});renderModels();$('#settings-feedback').textContent='Disconnected. Saved key removed.';}catch(e){toast(e.message);}};
// Asks for confirmation in a dialog and resolves to true when the user confirms.
function confirmAction({title,message,note='',confirm,cancel='Cancel'}){
  const dialog=$('#confirm-dialog');
  $('#confirm-title').textContent=title;$('#confirm-message').textContent=message;$('#confirm-note').textContent=note;
  $('#confirm-ok').textContent=confirm;$('#confirm-cancel').textContent=cancel;
  return new Promise(resolve=>{
    const finish=value=>{dialog.removeEventListener('close',closed);$('#confirm-ok').onclick=$('#confirm-cancel').onclick=null;if(dialog.open)dialog.close();resolve(value);};
    const closed=()=>finish(false);
    dialog.addEventListener('close',closed);
    $('#confirm-ok').onclick=()=>finish(true);$('#confirm-cancel').onclick=()=>finish(false);
    dialog.showModal();$('#confirm-cancel').focus();
  });
}
// Prompt-processing speed measured per model, used to estimate a full reprocess.
const prefillKey=(connectionId,modelId)=>'joltdesk-prefill:'+connectionId+'::'+modelId;
function rememberPrefill(timings){
  if(!current||!timings||!(timings.prompt_n>=500)||!(timings.prompt_per_second>0))return;
  try{localStorage.setItem(prefillKey(current.connectionId||config.connection?.id,current.model),String(timings.prompt_per_second));}catch{}
}
const knownPrefill=(connectionId,modelId)=>{try{return Number(localStorage.getItem(prefillKey(connectionId,modelId)))||null;}catch{return null;}};
const roughTime=seconds=>seconds<90?`about ${Math.max(10,Math.round(seconds/10)*10)} seconds`:seconds<5400?`about ${Math.round(seconds/60)} minutes`:`about ${(seconds/3600).toFixed(1)} hours`;
// Switching a long chat to another local model reprocesses the whole conversation,
// because each model keeps its own prompt cache. Say so before switching.
async function confirmModelSwitch(option){
  const fromConnection=current?.connectionId||config.connection?.id,toConnection=option?.dataset.connectionId||config.connection?.id;
  const toModel=option?.dataset.modelId||option?.value;
  if(!current||running||!toModel||(toConnection===fromConnection&&toModel===current.model))return true;
  if((config.connections||[]).find(c=>c.id===toConnection)?.provider!=='local')return true;
  const tokens=Number(stats.contextUsage?.tokens||0);
  if(tokens<4000)return true;
  const speed=knownPrefill(toConnection,toModel),name=option.textContent.trim();
  const estimate=speed?` At the ${Math.round(speed)} tokens per second measured for this model, that takes ${roughTime(tokens/speed)}.`:'';
  return confirmAction({
    title:'Switch model in this chat?',
    message:`${name} will process this whole conversation again, about ${Math.round(tokens/100)*100 >= 1000?Math.round(tokens/1000).toLocaleString()+'K':tokens.toLocaleString()} tokens, before it answers.${estimate}`,
    note:'Each model keeps its own cache, so the first message after a switch is slow. Starting a new chat with that model avoids this.',
    confirm:'Switch model',cancel:'Keep current model'
  });
}
$('#model').onchange=async()=>{try{const option=$('#model').selectedOptions[0];
  if(!await confirmModelSwitch(option)){renderModels();return;}if(option?.dataset.connectionId&&option.dataset.connectionId!==config.connection?.id){await useConnection(option.dataset.connectionId,option.dataset.modelId);return;}renderThinking();updateMetrics();config.preferredModel=$('#model').value;await api('/model',{modelId:$('#model').value});if(current){await patchChat({model:$('#model').value,connectionId:config.connection.id});ws?.send(JSON.stringify({type:'levels'}));}}catch(e){toast(e.message);renderModels();}};
$('#add-api').onclick=()=>{editConnection({provider:'local',maxTokens:'auto'},true);$('#settings-feedback').textContent='Add another API. Your saved connections will stay.';};
$('#connection-editor').onchange=()=>editConnection(config.connections.find(c=>c.id===$('#connection-editor').value)||{provider:'local',maxTokens:'auto'});
$('#auto-output-tokens').onchange=()=>{$('#max-output-tokens').disabled=$('#auto-output-tokens').checked;};
$('#max-output-tokens').placeholder='Auto if blank';$('#max-output-tokens').onblur=()=>{if(!$('#max-output-tokens').value){$('#auto-output-tokens').checked=true;$('#max-output-tokens').disabled=true;}};
$('#saved-connections').onclick=async e=>{const b=e.target.closest('button[data-action]');if(!b)return;const c=config.connections.find(c=>c.id===b.dataset.id);if(!c)return;try{if(b.dataset.action==='use'){b.disabled=true;await useConnection(c.id);$('#settings-feedback').textContent=`Using ${c.name}.`;}if(b.dataset.action==='edit')editConnection(c,true);if(b.dataset.action==='rename'){renamingApiId=c.id;$('#rename-api-name').value=c.name;$('#rename-api-feedback').textContent='';$('#rename-api-dialog').showModal();}if(b.dataset.action==='remove'||b.dataset.action==='cancel-remove'){removingApiId=b.dataset.action==='remove'?c.id:null;renderSavedConnections();}if(b.dataset.action==='confirm-remove'){config=await api(`/connections/${c.id}`,{},'DELETE');connectionDrafts.delete(c.id);if(editingConnectionId===c.id)editingConnectionId=config.connection?.id||'';removingApiId=null;renderModels();$('#settings-feedback').textContent='API removed. Other connections and chats are preserved.';}}catch(e){$('#settings-feedback').textContent=e.message;}finally{b.disabled=false;}};
$('#rename-api-form').onsubmit=async e=>{e.preventDefault();try{config=await api(`/connections/${renamingApiId}`,{name:$('#rename-api-name').value},'PATCH');renderModels();$('#rename-api-dialog').close();}catch(e){$('#rename-api-feedback').textContent=e.message;}};
$('#thinking').onchange=()=>patchChat({thinking:$('#thinking').value}).catch(e=>toast(e.message));
$('#web-tools').onchange=async event=>{
  const toggle=event.currentTarget;
  try{await patchChat({webEnabled:toggle.checked});}
  catch(error){toggle.checked=!!current?.webEnabled;toast(error.message);}
};
$('#permission').onchange=async()=>{const mode=$('#permission').value;$('#permission').disabled=true;try{if(!current)await newChat();await patchChat({mode});$('#permission').value=mode;$('#permission').classList.toggle('bypass',mode==='bypass');toast(mode==='bypass'?'Bypass active. Tools can run without approval.':'Permissions updated.');}catch(e){$('#permission').value=current?.mode||'chat';toast(e.message);}finally{$('#permission').disabled=false;}};
$('#add-project').onclick=()=>$('#project-dialog').showModal();
$('#browse').onclick=async()=>{try{const r=await api('/pick-folder',{});if(r.path){$('#project-path').value=r.path;if(!$('#project-name').value)$('#project-name').value=r.path.split(/[\\/]/).at(-1);}}catch(e){toast(e.message);}};
$('#project-form').onsubmit=async e=>{e.preventDefault();try{const p=await api('/projects',{name:$('#project-name').value,path:$('#project-path').value});config.projects.push(p);projectId=p.id;$('#project-dialog').close();renderSidebar();await newChat();}catch(e){$('#project-feedback').textContent=e.message;}};
function renderFiles(){$('#attachments').innerHTML=files.map((f,i)=>`<div class="attachment" title="${esc(f.path||'Saved copy after sending')}">▧ ${esc(f.name)} · ${esc(f.path?(f.path.split(/[\\/]/).slice(-2,-1)[0]||f.path):'saved copy')} <button data-index="${i}" title="Remove attachment">✕</button></div>`).join('');$('#attachments').querySelectorAll('button').forEach(b=>b.onclick=()=>{files.splice(Number(b.dataset.index),1);renderFiles();});}
async function addFiles(list){for(const f of list){if(f.size>8*1024*1024){toast(`${f.name}: maximum file size is 8 MB.`);continue;}const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(f);});let filePath='';try{filePath=window.joltFiles?.pathFor(f)||'';}catch{}files.push({name:f.name||`pasted-image-${Date.now()}.${({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'})[f.type]||'bin'}`,type:f.type,data,path:filePath});}renderFiles();}
$('#attach').onclick=()=>$('#file-input').click();$('#file-input').onchange=async e=>{await addFiles(e.target.files);e.target.value='';};
$('#prompt').onpaste=async e=>{const f=[...e.clipboardData.items].filter(i=>i.kind==='file').map(i=>i.getAsFile());if(f.length){e.preventDefault();await addFiles(f);}};
document.body.ondragover=e=>e.preventDefault();document.body.ondrop=async e=>{e.preventDefault();await addFiles(e.dataTransfer.files);};
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{$('#prompt').value=b.dataset.prompt;$('#prompt').focus();});
$('#compact').onclick=()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'compact'}));else toast('Open a conversation first.');};
$('#collapse').onclick=()=>document.body.classList.toggle('sidebar-hidden');$('#mobile-sidebar').onclick=()=>{document.body.classList.remove('sidebar-hidden');document.body.classList.toggle('sidebar-open');};
$('#theme').onclick=()=>{document.body.classList.toggle('light');localStorage.setItem('bolt-theme',document.body.classList.contains('light')?'light':'dark');};
if(localStorage.getItem('bolt-theme')==='light')document.body.classList.add('light');
const fileDates=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
let fileMenuTarget;
function paintFileDates(state){
  for(const row of $('#inspector-files').querySelectorAll('[data-file-path]')){
    const modifiedAt=state?.fileModifiedAt?.[row.dataset.filePath];
    const time=row.querySelector('time');
    time.hidden=!Number.isFinite(modifiedAt);
    if(!time.hidden){
      const date=new Date(modifiedAt);
      time.dateTime=date.toISOString();
      time.textContent='Last edited '+fileDates.format(date);
    }
  }
}
function renderInspector(){
  const state=chatStates.get(current?.id);
  const info=collectInspector(messages,state?.inspector);
  $('#inspector-files').innerHTML=info.files.map(f=>{
    const name=`${f.action==='edited'?'✎':'▤'} ${esc(f.path.split(/[\\/]/).at(-1))}`;
    const label=config?.native&&f.status==='done'?`<button type="button" class="inspector-file-name" title="${esc(f.path)}" aria-haspopup="menu">${name}</button>`:`<span title="${esc(f.path)}">${name}</span>`;
    return `<div class="inspector-file" data-file-path="${esc(f.path)}">${label}<small>${f.action==='edited'?'Edited':'Read'} · ${esc(f.status)}</small><time hidden></time></div>`;
  }).join('')||'<p class="inspector-empty">No file activity in this chat.</p>';
  $('#inspector-sources').innerHTML=info.sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}<small>${esc(new URL(s.url).hostname)}</small></a>`).join('')||'<p class="inspector-empty">Source links from replies appear here.</p>';
  paintFileDates(state);
  if(!state||!document.body.classList.contains('inspector-open'))return;
  const signature=JSON.stringify(info.files.map(f=>[f.path,f.status]));
  if(!info.files.length||state.fileSignature===signature)return;
  state.fileSignature=signature;
  const request=Symbol();
  state.fileRequest=request;
  api(`/chats/${state.chat.id}/files`).then(result=>{
    if(state.fileRequest!==request)return;
    state.fileModifiedAt=result.modifiedAt;
    if(current?.id===state.chat.id)paintFileDates(state);
  }).catch(()=>{if(state.fileRequest===request)state.fileSignature=null;});
}
function showFileMenu(event){
  const button=event.target.closest('.inspector-file-name');
  if(!button||!current)return;
  event.preventDefault();
  const menu=$('#file-menu');
  fileMenuTarget={chatId:current.id,path:button.closest('[data-file-path]').dataset.filePath,button};
  menu.showPopover();
  const bounds=button.getBoundingClientRect();
  const x=event.type==='contextmenu'&&event.clientX?event.clientX:bounds.left;
  const y=event.type==='contextmenu'&&event.clientY?event.clientY:bounds.bottom;
  menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';
  menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
  menu.querySelector('button').focus();
}
$('#inspector-files').addEventListener('click',showFileMenu);
$('#inspector-files').addEventListener('contextmenu',showFileMenu);
$('#file-menu').addEventListener('click',async event=>{
  const action=event.target.closest('[data-file-action]')?.dataset.fileAction;
  if(!action||!fileMenuTarget)return;
  const {chatId,path,button}=fileMenuTarget;
  $('#file-menu').hidePopover();
  button.focus();
  try{await api(`/chats/${chatId}/file-action`,{action,path});}catch(error){toast(error.message);}
});
$('#file-menu').addEventListener('keydown',event=>{
  const menu=event.currentTarget;
  if(event.key==='Escape'){event.preventDefault();menu.hidePopover();fileMenuTarget?.button.focus();return;}
  if(!['ArrowDown','ArrowUp'].includes(event.key))return;
  event.preventDefault();
  const items=[...menu.querySelectorAll('button')];
  items[(items.indexOf(document.activeElement)+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
});
const inspectorToggle=document.createElement('button');inspectorToggle.id='toggle-inspector';inspectorToggle.className='icon';inspectorToggle.title='Files & browser';inspectorToggle.setAttribute('aria-label','Toggle files and browser panel');inspectorToggle.textContent='▥';$('.header-actions').append(inspectorToggle);
const setInspector=open=>{
  document.body.classList.toggle('inspector-open',open);
  inspectorToggle.setAttribute('aria-expanded',String(open));
  if(!open){$('#file-menu').hidePopover();return;}
  const state=chatStates.get(current?.id);
  if(state)state.fileSignature=null;
  renderInspector();
};
inspectorToggle.onclick=()=>setInspector(!document.body.classList.contains('inspector-open'));$('#close-inspector').onclick=()=>setInspector(false);setInspector(innerWidth>=1200);
const resizer=$('#sidebar-resizer');let resizing=false;
function setSidebarWidth(width){const value=Math.max(200,Math.min(480,innerWidth-80,width));document.documentElement.style.setProperty('--sidebar-width',value+'px');resizer.setAttribute('aria-valuenow',Math.round(value));resizer.setAttribute('aria-valuemin','200');resizer.setAttribute('aria-valuemax','480');return value;}
setSidebarWidth(Number(localStorage.getItem('bolt-sidebar-width'))||265);
resizer.onpointerdown=e=>{resizing=true;resizer.setPointerCapture(e.pointerId);document.body.classList.add('sidebar-resizing');e.preventDefault();};resizer.onpointermove=e=>{if(resizing)setSidebarWidth(e.clientX);};const finishResize=()=>{resizing=false;document.body.classList.remove('sidebar-resizing');try{localStorage.setItem('bolt-sidebar-width',String(resizer.getAttribute('aria-valuenow')));}catch{}};resizer.onpointerup=finishResize;resizer.onpointercancel=finishResize;
resizer.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();setSidebarWidth(e.key==='Home'?200:e.key==='End'?480:Number(resizer.getAttribute('aria-valuenow'))+(e.key==='ArrowLeft'?-16:16));finishResize();};window.addEventListener('resize',()=>{if(innerWidth<1100)setInspector(false);});
const inspectorResizer=document.createElement('div');inspectorResizer.id='inspector-resizer';inspectorResizer.setAttribute('role','separator');inspectorResizer.setAttribute('aria-orientation','vertical');inspectorResizer.setAttribute('aria-label','Resize files and sources');inspectorResizer.tabIndex=0;$('#work-panel').prepend(inspectorResizer);
// Files and Browser share the side panel and remember separate widths.
const panelSizes={files:{key:'bolt-inspector-width',css:'--inspector-width',min:220,cap:600,main:420},terminal:{key:'joltdesk-terminal-width',css:'--terminal-width',min:320,cap:1600,main:380},git:{key:'joltdesk-git-width',css:'--git-width',min:300,cap:1400,main:380},changes:{key:'joltdesk-changes-width',css:'--changes-width',min:300,cap:1400,main:380},browser:{key:'joltdesk-browser-width',css:'--browser-width',min:320,cap:1600,main:380}};
const panelWidths={files:Number(localStorage.getItem('bolt-inspector-width'))||250,changes:Number(localStorage.getItem('joltdesk-changes-width'))||440,git:Number(localStorage.getItem('joltdesk-git-width'))||420,terminal:Number(localStorage.getItem('joltdesk-terminal-width'))||520,browser:Number(localStorage.getItem('joltdesk-browser-width'))||Math.round(innerWidth*.42)};
let inspectorResize=null;
function setInspectorWidth(width){const size=panelSizes[panelMode()],sidebar=innerWidth>=1100?$('#sidebar').getBoundingClientRect().width:0,max=Math.max(size.min,Math.min(size.cap,innerWidth-(innerWidth>=1100?sidebar+size.main:32)));const value=Math.round(Math.max(size.min,Math.min(max,width)));document.documentElement.style.setProperty(size.css,value+'px');inspectorResizer.setAttribute('aria-valuenow',value);inspectorResizer.setAttribute('aria-valuemin',String(size.min));inspectorResizer.setAttribute('aria-valuemax',Math.floor(max));return value;}
const applyPanelWidth=()=>{panelWidths[panelMode()]=setInspectorWidth(panelWidths[panelMode()]);};
applyPanelWidth();window.addEventListener('panelmodechange',applyPanelWidth);
inspectorResizer.onpointerdown=e=>{if(e.button!==0)return;inspectorResize={x:e.clientX,width:$('#work-panel').getBoundingClientRect().width};inspectorResizer.setPointerCapture(e.pointerId);document.body.classList.add('sidebar-resizing');e.preventDefault();};
inspectorResizer.onpointermove=e=>{if(inspectorResize)panelWidths[panelMode()]=setInspectorWidth(inspectorResize.width+inspectorResize.x-e.clientX);};
const finishInspectorResize=()=>{inspectorResize=null;document.body.classList.remove('sidebar-resizing');try{localStorage.setItem(panelSizes[panelMode()].key,String(panelWidths[panelMode()]));}catch{}};
inspectorResizer.onpointerup=finishInspectorResize;inspectorResizer.onpointercancel=finishInspectorResize;inspectorResizer.onlostpointercapture=finishInspectorResize;
inspectorResizer.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();panelWidths[panelMode()]=setInspectorWidth(e.key==='Home'?0:e.key==='End'?Infinity:Number(inspectorResizer.getAttribute('aria-valuenow'))+(e.key==='ArrowLeft'?16:-16));finishInspectorResize();};
window.addEventListener('resize',()=>setInspectorWidth(panelWidths[panelMode()]));new ResizeObserver(()=>setInspectorWidth(panelWidths[panelMode()])).observe($('#sidebar'));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='n'){e.preventDefault();newChat(null);}if((e.ctrlKey||e.metaKey)&&e.key===','){e.preventDefault();$('#settings-dialog').showModal();}});
const browser=initBrowserPanel({toast,showPanel:()=>setInspector(true),onAttach:file=>{files.push(file);renderFiles();$('#prompt').focus();}});
changesPanel=initChangesPanel({api,toast,currentChat:()=>current,isRunning:()=>running});
gitPanel=initGitPanel({api,toast,currentChat:()=>current,isRunning:()=>running});
terminalPanel=initTerminalPanel({api,toast,currentChat:()=>current,abortAgent:()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'abort'}));}});
skillsPanel=initSkills({api,toast,currentChat:()=>current,getConfig:()=>config});
instructionsPanel=initInstructions({api,toast,currentChat:()=>current,getConfig:()=>config,setConfig:value=>{config=value;}});
initSidePanel({browser:browser.available});
// Links in replies and sources open in the built-in browser. Ctrl or Shift click uses the default browser.
document.addEventListener('click',e=>{
  const link=e.target.closest('#messages a[href], #inspector-sources a[href]');
  if(!link||!browser.available||e.ctrlKey||e.shiftKey||e.metaKey||!/^https?:/i.test(link.href))return;
  e.preventDefault();browser.open(link.href);
});
// Startup buttons stay disabled until their handlers are attached and the workspace has loaded.
try{config=await api('/config');renderSidebar();renderChat();updateMetrics();}catch(e){toast(e.message);}
finally{
  // The server checks the API in the background after startup. Refresh once it finishes.
  const followStartup=async()=>{if(!config?.refreshing)return;try{const next=await api('/config');const busy=current&&running;config={...next,refreshing:next.refreshing};if(!busy){renderSidebar();renderModels();updateMetrics();}if(next.refreshing)setTimeout(followStartup,1000);}catch{}};
  setTimeout(followStartup,800);
  document.querySelectorAll('[data-startup]').forEach(button=>button.disabled=false);if(config?.version){$('#app-version').textContent='v'+config.version;$('#app-version').title='JoltDesk '+config.version;}}
