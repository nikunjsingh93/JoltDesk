const {lookup}=require('node:dns/promises');
const {BlockList}=require('node:net');
const http=require('node:http');
const https=require('node:https');

const reserved=new BlockList();
for(const [address,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
])reserved.addSubnet(address,prefix,'ipv4');

function publicUrl(value){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port){
    throw new Error('Use a public HTTP or HTTPS URL with the standard port.');
  }
  return url;
}

async function assertPublicAddress(value){
  const url=publicUrl(value);
  const {address}=await lookup(url.hostname,{family:4});
  if(reserved.check(address,'ipv4'))throw new Error('This address is outside the public web.');
  return url.href;
}

async function readPublicPage(value,signal){
  let url=publicUrl(value);
  for(let redirects=0;redirects<=4;redirects++){
    signal.throwIfAborted();
    const {address}=await lookup(url.hostname,{family:4});
    if(reserved.check(address,'ipv4'))throw new Error('This address is outside the public web.');
    // Pin the validated address while keeping the hostname for TLS and the Host header.
    const transport=url.protocol==='https:'?https:http;
    const page=await new Promise((resolve,reject)=>{
      const request=transport.get(url,{
        family:4,agent:false,signal,
        lookup:(_name,options,callback)=>options.all?callback(null,[{address,family:4}]):callback(null,address,4),
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36','Accept':'text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8','Accept-Encoding':'identity'}
      },response=>{
        const status=response.statusCode;
        if([301,302,303,307,308].includes(status)&&response.headers.location){
          resolve({redirect:response.headers.location});
          response.destroy();
          return;
        }
        if(status!==200){
          reject(new Error('The site returned HTTP '+status+'.'));
          response.destroy();
          return;
        }
        const mime=String(response.headers['content-type']||'').split(';')[0].trim();
        if(!['text/html','text/plain','application/xhtml+xml'].includes(mime)){
          reject(new Error('The page reader supports HTML and plain text pages.'));
          response.destroy();
          return;
        }
        const chunks=[];
        let size=0;
        response.on('data',chunk=>{
          size+=chunk.length;
          if(size>1500000){response.destroy(new Error('The page is too large to read.'));return;}
          chunks.push(chunk);
        });
        response.on('error',reject);
        response.on('end',()=>resolve({mime,html:Buffer.concat(chunks).toString('utf8'),url:url.href}));
      });
      request.on('error',reject);
    });
    if(!page.redirect)return page;
    url=publicUrl(new URL(page.redirect,url));
  }
  throw new Error('The site redirected too many times.');
}

// This function runs in a blank sandboxed Electron window. The fetched page is
// parsed as an inert document and its scripts and subresources never run.
function parsePage(html,url,search){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const clean=(text,max)=>String(text||'').replace(/\s+/g,' ').trim().slice(0,max);
  const link=value=>{
    try{
      let target=new URL(value,url);
      if((target.hostname==='duckduckgo.com'||target.hostname.endsWith('.duckduckgo.com'))&&target.searchParams.has('uddg')){
        target=new URL(target.searchParams.get('uddg'));
      }
      return ['http:','https:'].includes(target.protocol)&&!target.username&&!target.password?target.href:null;
    }catch{return null;}
  };
  if(search){
    const sources=[];
    const seen=new Set();
    for(const anchor of doc.querySelectorAll('.result__a')){
      const url=link(anchor.getAttribute('href'));
      if(!url||seen.has(url))continue;
      seen.add(url);
      sources.push({url,title:clean(anchor.textContent,200),snippet:clean(anchor.closest('.result')?.querySelector('.result__snippet')?.textContent,400)});
      if(sources.length===6)break;
    }
    return {sources,blocked:!!doc.querySelector('form[action*="anomaly.js"],.anomaly-modal')};
  }
  doc.querySelectorAll('script,style,noscript,template,nav,footer,aside,form,[hidden]').forEach(node=>node.remove());
  const root=doc.querySelector('main,article,[role="main"]')||doc.body;
  const links=[];
  const seen=new Set();
  for(const anchor of root.querySelectorAll('a[href]')){
    const href=link(anchor.getAttribute('href'));
    const title=clean(anchor.textContent,160);
    if(!href||!title||seen.has(href))continue;
    seen.add(href);
    links.push({url:href,title});
    if(links.length===15)break;
  }
  root.querySelectorAll('p,li,pre,h1,h2,h3,h4,blockquote,br,tr').forEach(node=>node.append('\n'));
  const text=root.textContent.split('\n').map(line=>clean(line,2500)).filter(Boolean).join('\n').slice(0,12000);
  return {url,title:clean(doc.title,200)||new URL(url).hostname,text,links};
}

function createWebTools(BrowserWindow){
  async function parse(page,search){
    const window=new BrowserWindow({show:false,webPreferences:{partition:'bolt-web-reader',sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try{
      const contents=window.webContents;
      contents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','file:///*']},(_details,callback)=>callback({cancel:true}));
      contents.setWindowOpenHandler(()=>({action:'deny'}));
      await window.loadURL('about:blank');
      return await contents.executeJavaScript('('+parsePage.toString()+')('+JSON.stringify(page.html)+','+JSON.stringify(page.url)+','+Boolean(search)+')');
    }finally{window.destroy();}
  }
  return async(kind,input,signal)=>{
    if(kind==='search'){
      const query=typeof input.query==='string'?input.query.trim():'';
      if(!query||query.length>400)throw new Error('Enter a search query up to 400 characters.');
      const url=new URL('https://html.duckduckgo.com/html/');
      url.searchParams.set('q',query);
      const result=await parse(await readPublicPage(url,signal),true);
      if(result.blocked)throw new Error('DuckDuckGo is asking for a browser verification. Try searching again later.');
      return {sources:result.sources};
    }
    if(kind==='browse'){
      if(typeof input.url!=='string'||input.url.length>4096)throw new Error('Enter a valid page URL.');
      const page=await readPublicPage(input.url,signal);
      if(page.mime==='text/plain')return {url:page.url,title:new URL(page.url).hostname,text:page.html.slice(0,12000),links:[]};
      return await parse(page,false);
    }
    throw new Error('Unknown web tool.');
  };
}
module.exports={createWebTools,assertPublicAddress};
