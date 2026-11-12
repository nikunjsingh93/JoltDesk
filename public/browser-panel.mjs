// Renderer side of the built-in browser, shown as the Browser tab of the right
// side panel. Pages are native views owned by the desktop process and placed
// over #browser-viewport.
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import {panelMode,setPanelMode} from './side-panel.mjs';
const cleanError=error=>String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,'');

export function initBrowserPanel({toast,onAttach,showPanel}){
  const bridge=window.joltBrowser;
  if(!bridge)return {available:false,open:()=>false};

  let state={tabs:[],active:null,canGoBack:false,canGoForward:false},editingAddress=false;
  const viewport=$('#browser-viewport'),address=$('#browser-address');
  const command=(name,arg)=>bridge.command(name,arg).then(result=>{if(result?.type==='state')render(result);return result;}).catch(error=>{toast(cleanError(error));return null;});
  const reveal=()=>{setPanelMode('browser');showPanel();};

  // Native views paint above HTML, so hide the page while a dialog is open or
  // while the panel shows Files.
  const wanted=()=>document.body.classList.contains('inspector-open')&&panelMode()==='browser'&&!document.querySelector('dialog[open]');
  const rect=()=>{const r=viewport.getBoundingClientRect();return {x:r.left,y:r.top,width:Math.max(0,r.width),height:Math.max(0,r.height)};};
  let frame=0,shown=false;
  function sync(){
    cancelAnimationFrame(frame);clearTimeout(frame);
    // Hidden windows run no animation frames, so use a timer then.
    const schedule=document.hidden?callback=>setTimeout(callback,0):requestAnimationFrame;
    frame=schedule(()=>{
      const want=wanted();
      if(want!==shown){shown=want;command(want?'show':'hide',want?rect():undefined);}
      else if(want)bridge.command('bounds',rect()).catch(()=>{});
    });
  }
  new ResizeObserver(sync).observe(viewport);
  new ResizeObserver(sync).observe($('#sidebar'));
  window.addEventListener('resize',sync);
  new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['open'],subtree:true});
  new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['class']});

  function render(next){
    state=next;
    const tab=state.tabs.find(t=>t.id===state.active);
    $('#browser-tabs').innerHTML=state.tabs.map(t=>`<div class="browser-tab ${t.id===state.active?'active':''}" role="tab" aria-selected="${t.id===state.active}"><button type="button" data-tab="${t.id}" title="${esc(t.title)}\n${esc(t.url)}">${t.loading?'<span class="browser-spinner" aria-hidden="true"></span>':''}${t.agent?'<span class="browser-agent" title="Opened by the agent">ϟ</span>':''}<span>${esc(t.title)}</span></button><button type="button" class="browser-tab-close" data-close="${t.id}" aria-label="Close ${esc(t.title)}">✕</button></div>`).join('');
    if(!editingAddress)address.value=tab?.url&&tab.url!=='about:blank'?tab.url:'';
    $('#browser-back').disabled=!state.canGoBack;
    $('#browser-forward').disabled=!state.canGoForward;
    const reload=$('#browser-reload');reload.textContent=tab?.loading?'✕':'↻';reload.title=tab?.loading?'Stop':'Reload (Ctrl R)';
    $('#browser-attach').disabled=!/^https?:/.test(tab?.url||'');
    $('#browser-external').disabled=!/^https?:/.test(tab?.url||'');
    $('#browser-message').textContent=tab?.error?`${tab.error} — ${tab.url}`:state.tabs.length?'':'No tabs open. Press ＋ to open one.';
  }

  bridge.onEvent(message=>{
    if(message.type==='state')render(message);
    if(message.type==='reveal')reveal();
    if(message.type==='focus-address'){address.focus();address.select();}
    if(message.type==='notice')toast(message.text);
  });

  $('#browser-new-tab').onclick=()=>command('new-tab').then(()=>address.focus());
  $('#browser-back').onclick=()=>command('back');
  $('#browser-forward').onclick=()=>command('forward');
  $('#browser-reload').onclick=()=>command(state.tabs.find(t=>t.id===state.active)?.loading?'stop':'reload');
  $('#browser-external').onclick=()=>command('open-external');
  $('#browser-tabs').onclick=e=>{
    const close=e.target.closest('[data-close]');if(close){command('close-tab',Number(close.dataset.close));return;}
    const tab=e.target.closest('[data-tab]');if(tab)command('select-tab',Number(tab.dataset.tab));
  };
  $('#browser-tabs').onauxclick=e=>{const tab=e.target.closest('[data-tab]');if(e.button===1&&tab)command('close-tab',Number(tab.dataset.tab));};
  address.onfocus=()=>{editingAddress=true;address.select();};
  address.onblur=()=>{editingAddress=false;render(state);};
  address.onkeydown=e=>{if(e.key==='Escape')address.blur();};
  $('#browser-address-form').onsubmit=async e=>{e.preventDefault();const value=address.value;address.blur();await command('navigate',value);};
  $('#browser-attach').onclick=async()=>{
    $('#browser-attach').disabled=true;
    try{
      const page=await bridge.command('read');
      const body=`# ${page.title}\n\nSource: ${page.url}\n\n${page.text}`+(page.links.length?`\n\n## Links\n${page.links.map(l=>`- [${l.title}](${l.url})`).join('\n')}`:'');
      const name=(page.title.replace(/[\\/:*?"<>|]+/g,' ').trim().slice(0,60)||'page')+'.md';
      const bytes=new TextEncoder().encode(body);let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      onAttach({name,type:'text/markdown',data:btoa(binary)});
      toast('Page attached to your next message.');
    }catch(error){toast(cleanError(error));}
    finally{render(state);}
  };

  command('state');
  return {
    available:true,
    open(url){reveal();command('new-tab',url);return true;}
  };
}
