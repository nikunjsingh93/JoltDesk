// Skills: personal skills in Settings, the chat's skills in the Files tab, and
// "/" suggestions in the message box.
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function initSkills({api,toast,currentChat,getConfig}){
  let data=null,ticket=0,confirmRemove=null;
  const desktop=()=>!!getConfig()?.native;
  const chatQuery=()=>currentChat()?.id?`?chat=${encodeURIComponent(currentChat().id)}`:'';

  async function refresh(){
    const mine=++ticket;
    try{const next=await api('/skills'+chatQuery());if(mine===ticket){data=next;render();}}
    catch(error){if(mine===ticket){$('#inspector-skills').innerHTML=`<p class="inspector-empty">${esc(error.message)}</p>`;}}
  }
  const row=(skill,{settings=false}={})=>{
    const status=skill.problem?`<i class="skill-problem" title="${esc(skill.problem)}">not loaded</i>`:!skill.enabled?'<i>off</i>':skill.manual?'<i title="Runs only when you type /skill:'+esc(skill.name)+'">manual</i>':'';
    const name=desktop()?`<button type="button" class="skill-open" data-open="${esc(skill.id)}" title="Open ${esc(skill.file)}">${esc(skill.name)}</button>`:`<span class="skill-name" title="${esc(skill.file)}">${esc(skill.name)}</span>`;
    const toggle=`<input type="checkbox" data-toggle="${esc(skill.id)}" aria-label="Use ${esc(skill.name)}" ${skill.enabled?'checked':''}>`;
    const remove=settings?(confirmRemove===skill.id?`<button type="button" class="skill-remove danger" data-remove="${esc(skill.id)}">Confirm remove</button>`:`<button type="button" class="skill-remove" data-ask-remove="${esc(skill.id)}" title="Move this skill to JoltDesk's trash folder">Remove</button>`):'';
    return `<div class="skill-row ${skill.active?'':'inactive'}">${toggle}<div class="skill-text"><div class="skill-title">${name}${status}</div><small title="${esc(skill.problem||skill.description)}">${esc(skill.problem||skill.description)}</small></div>${remove}</div>`;
  };

  function render(){
    if(!data)return;
    const personal=data.skills.filter(s=>s.source==='personal'),project=data.skills.filter(s=>s.source==='project');
    // Files tab: what this chat can use.
    let files=personal.length?personal.map(s=>row(s)).join(''):'<p class="inspector-empty">No personal skills. Add one in Settings → Skills.</p>';
    if(data.project){
      if(data.project.enabled)files+=`<div class="skill-group"><span>Project skills</span><button type="button" class="skill-link" data-project-skills="off">Stop using</button></div>`+(project.map(s=>row(s)).join('')||'<p class="inspector-empty">No skills in .agents/skills, .claude/skills or .pi/skills.</p>');
      else if(data.project.found)files+=`<div class="skill-trust"><p>This project has ${project.length} skill${project.length===1?'':'s'} in its folder. Project skills can tell the agent to run scripts, so review them before using them.</p><button type="button" data-project-skills="on">Use project skills</button></div>`;
    }
    $('#inspector-skills').innerHTML=files;
    // Settings: personal skills.
    $('#personal-skills').innerHTML=personal.length?personal.map(s=>row(s,{settings:true})).join(''):'<p class="inspector-empty">No skills yet. Create one or import a skill folder.</p>';
    $('#open-skills-folder').hidden=!desktop();
  }

  async function act(task){try{await task();}catch(error){toast(error.message);}await refresh();}
  for(const container of [$('#inspector-skills'),$('#personal-skills')]){
    container.addEventListener('change',event=>{
      const box=event.target.closest('[data-toggle]');if(!box)return;
      act(()=>api('/skills/toggle',{id:box.dataset.toggle,enabled:box.checked,chat:currentChat()?.id}));
    });
    container.addEventListener('click',event=>{
      const open=event.target.closest('[data-open]'),ask=event.target.closest('[data-ask-remove]'),remove=event.target.closest('[data-remove]'),project=event.target.closest('[data-project-skills]');
      if(open)act(()=>api('/skills/open',{id:open.dataset.open,chat:currentChat()?.id}));
      if(ask){confirmRemove=ask.dataset.askRemove;render();}
      if(remove){confirmRemove=null;act(async()=>{await api('/skills/remove',{id:remove.dataset.remove});toast('Skill moved to JoltDesk’s trash folder.');});}
      if(project&&data?.project)act(()=>api(`/projects/${data.project.id}/skills`,{enabled:project.dataset.projectSkills==='on'}));
    });
  }

  // Settings actions.
  const form=$('#new-skill-form');
  $('#new-skill').onclick=()=>{form.hidden=!form.hidden;if(!form.hidden)$('#new-skill-name').focus();};
  $('#cancel-new-skill').onclick=()=>{form.hidden=true;};
  $('#create-skill').onclick=()=>act(async()=>{
    await api('/skills',{name:$('#new-skill-name').value,description:$('#new-skill-description').value});
    $('#new-skill-name').value='';$('#new-skill-description').value='';form.hidden=true;
    $('#skills-feedback').textContent=desktop()?'Skill created and opened for editing.':'Skill created.';
  });
  $('#new-skill-name').addEventListener('input',event=>{event.target.value=event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g,'-');});
  $('#import-skill').onclick=()=>act(async()=>{
    const path=desktop()?undefined:prompt('Path of the skill folder to import');
    if(!desktop()&&!path)return;
    const result=await api('/skills/import',path?{path}:{});
    if(!result.cancelled)$('#skills-feedback').textContent='Skill imported.';
  });
  $('#open-skills-folder').onclick=()=>act(()=>api('/skills/open',{folder:true}));
  new MutationObserver(()=>{if($('#settings-dialog').open){confirmRemove=null;$('#skills-feedback').textContent='';refresh();}})
    .observe($('#settings-dialog'),{attributes:true,attributeFilter:['open']});

  // "/" suggestions in the message box.
  const promptBox=$('#prompt');
  const menu=document.createElement('div');
  menu.id='slash-menu';menu.className='slash-menu';menu.setAttribute('role','listbox');menu.hidden=true;
  $('.composer').append(menu);
  let items=[],index=0;
  function suggest(){
    const before=promptBox.value.slice(0,promptBox.selectionStart);
    const match=/^\/([\w:-]*)$/.exec(before);
    const skills=(data?.skills||[]).filter(s=>s.active);
    if(!match||!skills.length){menu.hidden=true;items=[];return;}
    const query=match[1].toLowerCase().replace(/^skill:?/,'');
    items=skills.filter(s=>s.name.startsWith(query)||s.name.includes(query)).slice(0,8);
    if(!items.length){menu.hidden=true;return;}
    index=Math.min(index,items.length-1);
    menu.innerHTML=items.map((s,i)=>`<div class="slash-item ${i===index?'active':''}" role="option" aria-selected="${i===index}" data-index="${i}"><code>/skill:${esc(s.name)}</code><small>${esc(s.description)}</small></div>`).join('');
    menu.hidden=false;
  }
  function choose(i){
    const skill=items[i];if(!skill)return;
    const rest=promptBox.value.slice(promptBox.selectionStart).replace(/^\S*/,'');
    promptBox.value=`/skill:${skill.name} `+rest.trimStart();
    const caret=skill.name.length+8;promptBox.setSelectionRange(caret,caret);
    menu.hidden=true;items=[];promptBox.focus();
  }
  promptBox.addEventListener('input',()=>{index=0;suggest();});
  promptBox.addEventListener('blur',()=>setTimeout(()=>{menu.hidden=true;},150));
  // Capture phase runs before the composer's own Enter-to-send handler.
  promptBox.addEventListener('keydown',event=>{
    if(menu.hidden||!items.length)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();index=(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;suggest();}
    else if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();choose(index);}
    else if(event.key==='Escape'){event.preventDefault();menu.hidden=true;}
  },true);
  menu.addEventListener('mousedown',event=>{const item=event.target.closest('[data-index]');if(item){event.preventDefault();choose(Number(item.dataset.index));}});

  return {refresh};
}
