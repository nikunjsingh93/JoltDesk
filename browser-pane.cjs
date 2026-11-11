// Built-in browser for the desktop app. Each tab is a sandboxed WebContentsView
// in its own persistent partition, laid over the renderer's #browser-viewport.
const {WebContentsView,ipcMain,shell,session}=require('electron');

const PARTITION='persist:joltdesk-browser';
const HOME=process.env.BOLT_BROWSER_HOME||'https://duckduckgo.com/';
const READ_WORLD=1999;
const isWeb=url=>/^https?:\/\//i.test(url);

function normalizeAddress(input){
  const text=String(input||'').trim();
  if(!text)return HOME;
  if(/^about:blank$/i.test(text))return 'about:blank';
  if(/^https?:\/\//i.test(text))return new URL(text).href;
  if(/^[a-z][\w+.-]*:/i.test(text)&&!/^(localhost|[\w.-]+):\d+/i.test(text))throw new Error('The browser opens HTTP and HTTPS pages.');
  if(!/\s/.test(text)&&/^(localhost|\[[\da-f:]+\]|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(text)){
    const local=/^(localhost|127\.|10\.|192\.168\.|\[)/i.test(text)||/^[\d.]+:\d+/.test(text);
    return new URL((local?'http://':'https://')+text).href;
  }
  const search=new URL('https://duckduckgo.com/');
  search.searchParams.set('q',text);
  return search.href;
}

// Runs in an isolated world so page scripts cannot alter the extraction code.
function readDocument(max){
  const clean=(text,limit)=>String(text||'').replace(/\s+/g,' ').trim().slice(0,limit);
  const root=document.querySelector('main,article,[role="main"]')||document.body;
  const text=String(root?.innerText||'').split('\n').map(line=>clean(line,2500)).filter(Boolean).join('\n').slice(0,max);
  const links=[];const seen=new Set();
  for(const anchor of (root||document).querySelectorAll('a[href]')){
    const url=anchor.href,title=clean(anchor.innerText||anchor.textContent,160);
    if(!/^https?:/i.test(url)||!title||seen.has(url))continue;
    seen.add(url);links.push({url,title});
    if(links.length===15)break;
  }
  return {url:location.href,title:clean(document.title,200)||location.hostname||location.href,text,links};
}

function createBrowserPane({window,appOrigin,checkAgentUrl}){
  const tabs=[];
  let active=null,seq=0,visible=false,bounds={x:0,y:0,width:0,height:0};
  const ses=session.fromPartition(PARTITION);
  ses.setUserAgent(ses.getUserAgent().replace(/\s(joltdesk|JoltDesk|Electron)\/\S+/g,''));
  const allowed=new Set(['fullscreen','clipboard-sanitized-write','pointerLock']);
  ses.setPermissionRequestHandler((_contents,permission,callback)=>callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_contents,permission)=>allowed.has(permission));
  ses.on('will-download',(_event,item)=>emit({type:'notice',text:`Downloading ${item.getFilename()}…`}));

  const emit=message=>{if(!window.isDestroyed())window.webContents.send('browser:event',message);};
  const tabState=tab=>{
    const contents=tab.view.webContents;
    return {id:tab.id,title:contents.getTitle()||tab.pendingUrl||'New tab',url:contents.getURL()||tab.pendingUrl||'',loading:contents.isLoading(),agent:tab.agent,error:tab.error||''};
  };
  const state=()=>{
    const tab=tabs.find(t=>t.id===active);
    const history=tab?.view.webContents.navigationHistory;
    return {type:'state',tabs:tabs.map(tabState),active,canGoBack:!!history?.canGoBack(),canGoForward:!!history?.canGoForward()};
  };
  let scheduled=false;
  const push=()=>{if(scheduled)return;scheduled=true;setImmediate(()=>{scheduled=false;emit(state());});};

  function layout(){
    const tab=tabs.find(t=>t.id===active);
    for(const t of tabs){
      const show=t===tab&&visible&&!t.error&&bounds.width>0&&bounds.height>0;
      if(show){
        if(!t.attached){window.contentView.addChildView(t.view);t.attached=true;}
        const zoom=window.webContents.getZoomFactor();
        t.view.setBounds({x:Math.round(bounds.x*zoom),y:Math.round(bounds.y*zoom),width:Math.round(bounds.width*zoom),height:Math.round(bounds.height*zoom)});
      }else if(t.attached){window.contentView.removeChildView(t.view);t.attached=false;}
    }
  }

  function createTab(url,{activate=true,agent=false}={}){
    const view=new WebContentsView({webPreferences:{partition:PARTITION,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,safeDialogs:true}});
    view.setBackgroundColor('#ffffff');
    const tab={id:++seq,view,agent,pendingUrl:url,attached:false,error:''};
    const contents=view.webContents;
    contents.setWindowOpenHandler(({url:target,disposition})=>{
      if(isWeb(target))createTab(target,{activate:disposition!=='background-tab'});
      return {action:'deny'};
    });
    contents.on('will-navigate',(event,target)=>{
      if(isWeb(target)||target==='about:blank')return;
      event.preventDefault();
      if(/^mailto:/i.test(target))shell.openExternal(target);
    });
    contents.on('did-start-navigation',(_e,_url,_inPage,isMain)=>{if(isMain&&tab.error){tab.error='';layout();push();}});
    contents.on('did-fail-load',(_e,code,description,_url,isMain)=>{if(isMain&&code!==-3){tab.error=description||'The page could not load.';layout();push();}});
    contents.on('render-process-gone',()=>{tab.error='This page stopped responding. Reload to try again.';layout();push();});
    for(const name of ['did-start-loading','did-stop-loading','did-navigate','did-navigate-in-page','page-title-updated'])contents.on(name,push);
    contents.on('before-input-event',(event,input)=>{
      if(input.type!=='keyDown')return;
      const ctrl=input.control||input.meta,key=input.key.toLowerCase();
      const command=ctrl&&key==='l'?'focus-address':ctrl&&key==='t'?'new-tab':ctrl&&key==='w'?'close-tab':(ctrl&&key==='r')||key==='f5'?'reload':input.alt&&key==='arrowleft'?'back':input.alt&&key==='arrowright'?'forward':'';
      if(!command)return;
      event.preventDefault();
      if(command==='focus-address'){window.webContents.focus();emit({type:'focus-address'});}
      else run(command,command==='close-tab'?tab.id:undefined);
    });
    tabs.push(tab);
    if(activate)select(tab.id);
    contents.loadURL(url).catch(()=>{});
    push();
    return tab;
  }
  function select(id){
    if(!tabs.some(t=>t.id===id))return;
    active=id;layout();push();
  }
  function close(id){
    const index=tabs.findIndex(t=>t.id===id);
    if(index<0)return;
    const [tab]=tabs.splice(index,1);
    if(tab.attached)window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if(active===id)active=tabs[Math.min(index,tabs.length-1)]?.id??null;
    layout();push();
  }
  async function read(tab,max){
    if(!tab)throw new Error('No page is open in the JoltDesk browser.');
    const contents=tab.view.webContents;
    if(!isWeb(contents.getURL()))throw new Error('Open a web page in the JoltDesk browser first.');
    return contents.executeJavaScriptInIsolatedWorld(READ_WORLD,[{code:`(${readDocument})(${Number(max)})`}]);
  }
  function waitForLoad(tab,signal){
    const contents=tab.view.webContents;
    return new Promise((resolve,reject)=>{
      const done=()=>{cleanup();setTimeout(resolve,400);};
      const failed=(_e,code,description,_url,isMain)=>{if(isMain&&code!==-3){cleanup();reject(new Error(description||'The page could not load.'));}};
      const aborted=()=>{cleanup();reject(signal.reason||new Error('The page took too long to load.'));};
      const cleanup=()=>{contents.off('did-stop-loading',done);contents.off('did-fail-load',failed);signal?.removeEventListener('abort',aborted);};
      contents.on('did-stop-loading',done);contents.on('did-fail-load',failed);
      signal?.addEventListener('abort',aborted,{once:true});
    });
  }

  function run(name,arg){
    const tab=tabs.find(t=>t.id===active);
    const contents=tab?.view.webContents;
    switch(name){
      case 'show':visible=true;if(arg)bounds=arg;if(!tabs.length)createTab(HOME);layout();return state();
      case 'hide':visible=false;layout();return state();
      case 'bounds':bounds=arg;layout();return null;
      case 'state':return state();
      case 'navigate':{const url=normalizeAddress(arg);if(!tab){createTab(url);return state();}tab.agent=false;tab.pendingUrl=url;contents.loadURL(url).catch(()=>{});return state();}
      case 'new-tab':createTab(arg?normalizeAddress(arg):HOME);return state();
      case 'close-tab':close(arg??active);return state();
      case 'select-tab':select(Number(arg));return state();
      case 'back':if(contents?.navigationHistory.canGoBack())contents.navigationHistory.goBack();return null;
      case 'forward':if(contents?.navigationHistory.canGoForward())contents.navigationHistory.goForward();return null;
      case 'reload':contents?.reload();return null;
      case 'stop':contents?.stop();return null;
      case 'open-external':{const url=contents?.getURL();if(url&&isWeb(url))shell.openExternal(url);return null;}
      case 'read':return read(tab,30000);
      default:throw new Error('Unknown browser command.');
    }
  }

  ipcMain.handle('browser:command',(event,name,arg)=>{
    if(event.sender!==window.webContents||new URL(event.senderFrame.url).origin!==appOrigin)throw new Error('Browser commands are limited to JoltDesk.');
    return run(String(name),arg);
  });
  window.on('closed',()=>ipcMain.removeHandler('browser:command'));

  return {
    run,
    // Agent access: open a public page in a visible tab, or read the active tab.
    async agent(kind,input,signal){
      if(kind==='browser-read')return read(tabs.find(t=>t.id===active),12000);
      if(kind!=='browser-open')throw new Error('Unknown browser tool.');
      if(typeof input.url!=='string'||input.url.length>4096)throw new Error('Enter a valid page URL.');
      const url=await checkAgentUrl(input.url);
      emit({type:'reveal'});
      const tab=createTab(url,{agent:true});
      await waitForLoad(tab,signal);
      return read(tab,12000);
    }
  };
}

module.exports={createBrowserPane,normalizeAddress};
