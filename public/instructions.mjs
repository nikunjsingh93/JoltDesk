// Instruction files in the Files tab and personal instructions in Settings.
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function initInstructions({api,toast,currentChat,getConfig,setConfig}){
  const list=$('#inspector-instructions'),field=$('#personal-instructions'),dialog=$('#settings-dialog');
  let info=null,chatId=null,ticket=0,dirty=false;

  async function refresh(){
    const chat=currentChat();
    chatId=chat?.id||null;
    if(!chatId){info=null;render();return;}
    const mine=++ticket,id=chatId;
    try{const next=await api(`/chats/${id}/instructions`);if(mine===ticket&&id===chatId){info=next;render();}}
    catch(error){if(mine===ticket){list.innerHTML=`<p class="inspector-empty">${esc(error.message)}</p>`;}}
  }

  function render(){
    if(!info){list.innerHTML='<p class="inspector-empty">Open a conversation to see the instructions its agent follows.</p>';return;}
    const desktop=!!getConfig()?.native;
    const rows=info.files.map(file=>{
      const where=file.kind==='personal'?'All chats · Settings':file.kind==='project'?'This project':esc(file.folder);
      const label=file.kind==='personal'||desktop
        ?`<button type="button" class="instruction-open" ${file.path?`data-path="${esc(file.path)}"`:'data-personal'} title="${esc(file.path||'Edit in Settings')}">${esc(file.name)}</button>`
        :`<span title="${esc(file.path)}">${esc(file.name)}</span>`;
      return `<div class="inspector-file instruction-file">${label}<small>${where}</small></div>`;
    }).join('');
    const create=info.canCreate?'<button type="button" class="instruction-create" data-create title="Create an AGENTS.md file in this chat’s folder">＋ Create AGENTS.md</button>':'';
    list.innerHTML=(rows||'<p class="inspector-empty">No instruction files. The agent reads AGENTS.md or CLAUDE.md from this chat’s folder and the folders above it.</p>')+create;
  }

  list.addEventListener('click',async event=>{
    const open=event.target.closest('.instruction-open'),create=event.target.closest('[data-create]');
    try{
      if(open?.dataset.path)await api(`/chats/${chatId}/instructions/open`,{path:open.dataset.path});
      else if(open){dialog.showModal();field.focus();}
      else if(create){
        create.disabled=true;
        info=await api(`/chats/${chatId}/instructions/create`,{});
        render();
        toast('Created AGENTS.md. The agent reads it from the next message.');
      }
    }catch(error){toast(error.message);if(create)create.disabled=false;}
  });

  // Load the saved text whenever Settings opens, unless the user is editing it.
  new MutationObserver(()=>{if(dialog.open&&!dirty){field.value=getConfig()?.instructions||'';$('#instructions-feedback').textContent='';}})
    .observe(dialog,{attributes:true,attributeFilter:['open']});
  field.addEventListener('input',()=>{dirty=true;$('#instructions-feedback').textContent='';});
  $('#save-instructions').onclick=async()=>{
    const button=$('#save-instructions');button.disabled=true;
    try{
      setConfig(await api('/instructions',{text:field.value}));
      dirty=false;
      $('#instructions-feedback').textContent='Saved. Chats use it from their next message.';
      refresh();
    }catch(error){$('#instructions-feedback').textContent=error.message;}
    finally{button.disabled=false;}
  };
  return {refresh};
}
