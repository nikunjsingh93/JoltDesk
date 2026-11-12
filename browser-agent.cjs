// Agent actions in the built-in browser: read with numbered elements, click, type,
// press keys, scroll and take screenshots. Page code runs in an isolated world, so
// page scripts cannot see or change it, and input is sent as real mouse and key events.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL,fileURLToPath}=require('node:url');

const WORLD=1999;
const KEYS={Enter:'Enter',Tab:'Tab',Escape:'Escape',Backspace:'Backspace',Delete:'Delete',Space:'Space',
  ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Up:'Up',Down:'Down',Left:'Left',Right:'Right',
  PageUp:'PageUp',PageDown:'PageDown',Home:'Home',End:'End'};

// Page side. Numbers the visible interactive elements and keeps them for later actions.
function snapshotPage(maxText,maxItems){
  const clean=(text,limit)=>String(text||'').replace(/\s+/g,' ').trim().slice(0,limit);
  const root=document.querySelector('main,article,[role="main"]')||document.body;
  const text=String(root?.innerText||'').split('\n').map(line=>clean(line,2500)).filter(Boolean).join('\n').slice(0,maxText);
  const selector='a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=searchbox],[role=textbox],[contenteditable="true"],[contenteditable=""]';
  const visible=el=>{const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;const s=getComputedStyle(el);return s.visibility!=='hidden'&&s.display!=='none'&&!el.disabled&&!el.closest('[aria-hidden="true"],[inert]');};
  const distance=el=>{const r=el.getBoundingClientRect();return r.bottom<0?-r.bottom:r.top>innerHeight?r.top-innerHeight:0;};
  // Prefer what is on screen, then what is closest to it, but list in page order.
  const chosen=[...document.querySelectorAll(selector)].filter(visible).map((el,index)=>({el,index,distance:distance(el)}))
    .sort((a,b)=>a.distance-b.distance||a.index-b.index).slice(0,maxItems).sort((a,b)=>a.index-b.index).map(item=>item.el);
  window.__joltRefs=chosen;
  const lines=chosen.map((el,i)=>{
    const tag=el.tagName.toLowerCase(),role=el.getAttribute('role'),type=tag==='input'?(el.getAttribute('type')||'text').toLowerCase():'';
    const kind=role||(tag==='a'?'link':tag==='select'?'select':tag==='textarea'||el.isContentEditable?'textbox':tag==='input'?(['checkbox','radio','range','file','color','date'].includes(type)?type:['submit','button','reset','image'].includes(type)?'button':type==='password'?'password':'textbox'):tag==='summary'?'button':tag);
    const label=clean(el.getAttribute('aria-label')||(el.labels&&el.labels[0]?.innerText)||(tag!=='input'&&tag!=='textarea'?el.innerText:'')||el.getAttribute('placeholder')||el.getAttribute('title')||el.querySelector?.('img[alt]')?.alt||el.getAttribute('alt')||(type==='submit'||type==='button'?el.value:'')||el.getAttribute('name')||'',80);
    let extra='';
    if(kind==='textbox'||kind==='searchbox'||kind==='combobox')extra=el.value?` value="${clean(el.value,60)}"`:'';
    if(kind==='checkbox'||kind==='radio'||role==='switch')extra=(el.checked||el.getAttribute('aria-checked')==='true')?' checked':' unchecked';
    if(tag==='select')extra=` selected="${clean(el.selectedOptions?.[0]?.text,40)}"`;
    if(tag==='a'&&el.href&&!/^javascript:/i.test(el.href))extra=` → ${el.href.slice(0,120)}`;
    const offscreen=distance(el)>0?' (off screen)':'';
    return `[${i}] ${kind}${label?` "${label}"`:''}${extra}${offscreen}`;
  });
  const height=Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0);
  return {url:location.href,title:clean(document.title,200)||location.hostname||location.href,text,elements:lines.join('\n'),
    scroll:{top:Math.round(scrollY),view:innerHeight,height}};
}

// Page side. Scrolls an element into view and reports where to click it.
function locateElement(ref,typing){
  const el=window.__joltRefs?.[ref];
  if(!el||!el.isConnected)return {error:`Element ${ref} is no longer on the page. Read the page again to get fresh element numbers.`};
  if(typing){
    const type=(el.getAttribute('type')||'').toLowerCase();
    if(type==='password')return {error:'JoltDesk does not let the agent type into password fields. Ask the user to enter it.'};
    const editable=el.isContentEditable||el.tagName==='TEXTAREA'||(el.tagName==='INPUT'&&!['checkbox','radio','button','submit','reset','image','file','range','color'].includes(type))||['textbox','searchbox','combobox'].includes(el.getAttribute('role'));
    if(!editable)return {error:`Element ${ref} is not a text field.`};
  }
  el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
  const r=el.getBoundingClientRect();
  return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
}

// Page side. Selects the focused field's text so typing replaces it.
function selectFocused(){
  const el=document.activeElement;
  if(!el)return false;
  if(typeof el.select==='function'){el.select();return true;}
  if(el.isContentEditable){const range=document.createRange();range.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(range);return true;}
  return false;
}
function scrollPage(direction,pages){
  const amount=Math.round(innerHeight*0.85*pages)*(direction==='up'?-1:1);
  window.scrollBy({top:amount,behavior:'instant'});
  return Math.round(scrollY);
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const loopback=host=>/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(host);

// Turns what the agent asked to open into a URL: public pages, local dev servers,
// or, with file permission, a local file.
async function resolveAgentUrl(value,{allowFiles,checkPublic}){
  const text=String(value||'').trim();
  if(!text||text.length>4096)throw new Error('Enter a valid page URL or file path.');
  if(/^\\\\/.test(text))throw new Error('Network file shares cannot be opened.');
  if(/^file:/i.test(text)||/^[a-zA-Z]:[\\/]/.test(text)||text.startsWith('/')){
    if(!allowFiles)throw new Error('Opening local files needs the Read files permission or higher in this chat.');
    const file=/^file:/i.test(text)?fileURLToPath(text):path.resolve(text);
    if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw new Error(`The file ${file} does not exist.`);
    return pathToFileURL(file).href;
  }
  let url;try{url=new URL(text);}catch{throw new Error('Enter a full URL such as https://example.com or a file path.');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('The browser opens web pages and local files.');
  if(loopback(url.hostname))return url.href;
  return checkPublic(url.href);
}

function createBrowserAgent({getActiveTab,createTab,waitForLoad,reveal,isAttached}){
  const call=(tab,fn,...args)=>tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD,[{code:`(${fn})(${args.map(a=>JSON.stringify(a)).join(',')})`}]);
  const readable=url=>/^(https?|file):/i.test(url);
  async function activeTab(){
    const tab=getActiveTab();
    if(!tab)throw new Error('No page is open in the JoltDesk browser. Open one with browser_open first.');
    if(!readable(tab.view.webContents.getURL()))throw new Error('Open a web page in the JoltDesk browser first.');
    reveal();
    for(let i=0;i<20&&!isAttached(tab);i++)await sleep(50);
    return tab;
  }
  const snapshot=(tab,maxText=6000,maxItems=60)=>call(tab,snapshotPage,maxText,maxItems);
  // Waits for a navigation that the action may have started, then for the page to settle.
  async function settle(tab,signal){
    const contents=tab.view.webContents;
    await sleep(300);
    if(contents.isLoading())await Promise.race([waitForLoad(tab,signal).catch(()=>{}),sleep(10000)]);
    else await sleep(300);
  }
  function mouseClick(contents,{x,y}){
    contents.sendInputEvent({type:'mouseMove',x,y});
    contents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    contents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
  }
  function pressKey(contents,key){
    const code=KEYS[key];
    if(!code)throw new Error(`Use one of these keys: ${Object.keys(KEYS).filter(k=>!['Up','Down','Left','Right'].includes(k)).join(', ')}.`);
    contents.sendInputEvent({type:'keyDown',keyCode:code});
    if(code==='Enter')contents.sendInputEvent({type:'char',keyCode:'\r'});
    if(code==='Space')contents.sendInputEvent({type:'char',keyCode:' '});
    contents.sendInputEvent({type:'keyUp',keyCode:code});
  }
  async function target(tab,ref,typing){
    if(!Number.isInteger(ref)||ref<0)throw new Error('Pass the element number from the page listing.');
    const point=await call(tab,locateElement,ref,!!typing);
    if(point.error)throw new Error(point.error);
    await sleep(80);
    return point;
  }

  return async function run(kind,input,signal,{allowFiles=false,checkPublic}={}){
    if(kind==='browser-open'){
      const url=await resolveAgentUrl(input.url,{allowFiles,checkPublic});
      reveal();
      const tab=createTab(url,{agent:true});
      await waitForLoad(tab,signal);
      return snapshot(tab,12000);
    }
    const tab=await activeTab();
    const contents=tab.view.webContents;
    switch(kind){
      case 'browser-read':return snapshot(tab,12000,80);
      case 'browser-click':{
        mouseClick(contents,await target(tab,Number(input.element)));
        await settle(tab,signal);
        return snapshot(tab);
      }
      case 'browser-type':{
        const text=String(input.text??'');
        if(text.length>5000)throw new Error('Type at most 5000 characters at a time.');
        mouseClick(contents,await target(tab,Number(input.element),true));
        await sleep(120);
        if(input.clear!==false)await call(tab,selectFocused);
        if(text)contents.insertText(text);
        if(input.submit===true){await sleep(80);pressKey(contents,'Enter');}
        await settle(tab,signal);
        return snapshot(tab);
      }
      case 'browser-press':{
        pressKey(contents,String(input.key||''));
        await settle(tab,signal);
        return snapshot(tab);
      }
      case 'browser-scroll':{
        const pages=Math.max(0.25,Math.min(10,Number(input.pages)||1));
        await call(tab,scrollPage,input.direction==='up'?'up':'down',pages);
        await sleep(400);
        return snapshot(tab);
      }
      case 'browser-screenshot':{
        await sleep(150);
        let image=await contents.capturePage();
        if(image.isEmpty())throw new Error('The browser is hidden, so it cannot take a screenshot. Open the Browser tab and try again.');
        if(image.getSize().width>1280)image=image.resize({width:1280});
        return {url:contents.getURL(),title:contents.getTitle(),image:image.toJPEG(72).toString('base64'),mimeType:'image/jpeg'};
      }
      default:throw new Error('Unknown browser tool.');
    }
  };
}

module.exports={createBrowserAgent,resolveAgentUrl,KEYS};
