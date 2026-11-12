// App-owned runtime policy. No project extensions or configuration are loaded.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const MAX_SNAPSHOT_BYTES=5*1024*1024;
function snapshot(input: any,ctx: any){
  let file=String(input?.path??input?.file_path??'');
  if(file.startsWith('@'))file=file.slice(1);
  if(file==='~'||/^~[\\/]/.test(file))file=homedir()+file.slice(1);
  const full=resolve(ctx?.cwd||process.cwd(),file);
  try{
    const stat=statSync(full);
    if(!stat.isFile()||stat.size>MAX_SNAPSHOT_BYTES)return {path:full,exists:true,tracked:false,data:null};
    return {path:full,exists:true,tracked:true,data:readFileSync(full).toString('base64')};
  }catch(error: any){
    return error?.code==='ENOENT'?{path:full,exists:false,tracked:true,data:null}:{path:full,exists:true,tracked:false,data:null};
  }
}

export default function(pi: any) {
  const modes=['chat','read','ask','bypass'];
  let mode=modes.includes(process.env.BOLT_PERMISSION_MODE||'')?process.env.BOLT_PERMISSION_MODE:'chat';
  const readTools=['read','grep','find','ls'];
  const fullTools=['read','write','edit','bash','powershell','grep','find','ls'];
  const webUrl=process.env.BOLT_WEB_URL;
  const webKey=process.env.BOLT_WEB_KEY;
  const browserActions=['browser_click','browser_type','browser_press'];
  const webTools=['web_search','browse_page','browser_open','browser_read','browser_click','browser_type','browser_press','browser_scroll','browser_screenshot'];
  let webEnabled=false;
  // Clicking and typing need one approval per chat unless the user chose bypass.
  let browserApproved=false;
  const object=(properties:any,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
  const element={type:'integer',description:'Element number from the latest page listing, for example 3 for [3].'};
  // Formats a browser snapshot: page text plus numbered elements the agent can act on.
  const pageText=(result:any)=>{
    const scroll=result.scroll&&result.scroll.height>result.scroll.view+8
      ?`\nScroll: ${Math.round(100*(result.scroll.top+result.scroll.view)/result.scroll.height)}% of the page is above the bottom of the window${result.scroll.top+result.scroll.view<result.scroll.height-8?', more below':''}.`:'';
    return `${result.title}\n${result.url}${scroll}\n\nPage text:\n${result.text||'(no text)'}\n\nInteractive elements (use the number with browser_click or browser_type):\n${result.elements||'(none found)'}`;
  };
  if(webUrl&&webKey){
    const browser=process.env.BOLT_BROWSER==='1';
    for(const tool of [
      {name:'web_search',label:'Search the web',kind:'search',parameters:object({query:{type:'string'}},['query']),description:'Find public web pages. Use the returned source URLs to cite the answer.'},
      {name:'browse_page',label:'Read a web page',kind:'browse',parameters:object({url:{type:'string'}},['url']),description:'Read the text and links of a public URL without running its scripts. Follow a link by calling this tool with its URL.'},
      ...(browser?[
        {name:'browser_open',label:'Open in JoltDesk browser',kind:'browser-open',parameters:object({url:{type:'string',description:'A web address, a local dev server such as http://localhost:3000, or the full path of a local file such as an HTML page you created.'}},['url']),description:'Open a page in a new tab of the user\'s visible JoltDesk browser and run its scripts. Returns the page text and numbered interactive elements. Use it to show pages, test web pages or local HTML files you built, and to start tasks that need clicking or typing.'},
        {name:'browser_read',label:'Read the browser page',kind:'browser-read',parameters:object({}),description:'Read the page currently open in the JoltDesk browser: its text and numbered interactive elements. Use this when the user refers to the page they are viewing, or to refresh element numbers.'},
        {name:'browser_click',label:'Click in the browser',kind:'browser-click',parameters:object({element},['element']),description:'Click a numbered element (link, button, checkbox, tab) on the open browser page. Returns the updated page.'},
        {name:'browser_type',label:'Type in the browser',kind:'browser-type',parameters:object({element,text:{type:'string'},submit:{type:'boolean',description:'Press Enter after typing, for example to run a search.'},clear:{type:'boolean',description:'Replace the existing text. Defaults to true.'}},['element','text']),description:'Type text into a numbered text field on the open browser page, optionally pressing Enter. Returns the updated page. Never use it for passwords.'},
        {name:'browser_press',label:'Press a key in the browser',kind:'browser-press',parameters:object({key:{type:'string',enum:['Enter','Tab','Escape','Backspace','Delete','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End']}},['key']),description:'Press a key on the open browser page, for example ArrowDown to move through suggestions or Escape to close a dialog. Returns the updated page.'},
        {name:'browser_scroll',label:'Scroll the browser',kind:'browser-scroll',parameters:object({direction:{type:'string',enum:['down','up']},pages:{type:'number',description:'How many screens to scroll. Defaults to 1.'}},['direction']),description:'Scroll the open browser page to see more of it. Returns the updated page.'},
        {name:'browser_screenshot',label:'Screenshot the browser',kind:'browser-screenshot',parameters:object({}),description:'Take a screenshot of the open browser page to check how it looks, for example the layout of a page you built. Needs a model that accepts images.'}
      ]:[])
    ]){
      pi.registerTool({
        name:tool.name,label:tool.label,description:tool.description,defaultActive:false,
        parameters:tool.parameters,
        async execute(_id:string,input:any,signal?:AbortSignal){
          const response=await fetch(webUrl,{
            method:'POST',headers:{'Content-Type':'application/json','X-Bolt-Web-Key':webKey},
            body:JSON.stringify({kind:tool.kind,input:input||{}}),signal
          });
          const result=await response.json();
          if(!response.ok)throw new Error(result.error||'Web request failed.');
          if(tool.kind==='search'){
            const sources=result.sources;
            return {content:[{type:'text',text:sources.map((source:any)=>source.title+'\n'+source.url+'\n'+source.snippet).join('\n\n')||'No search results.'}],details:{sources}};
          }
          const sources=/^https?:/.test(result.url||'')?[{url:result.url,title:result.title}]:[];
          if(tool.kind==='browse')return {content:[{type:'text',text:result.title+'\n'+result.url+'\n\n'+result.text+'\n\nLinks:\n'+result.links.map((link:any)=>link.title+' — '+link.url).join('\n')}],details:{sources}};
          if(tool.kind==='browser-screenshot')return {content:[{type:'image',data:result.image,mimeType:result.mimeType},{type:'text',text:`Screenshot of ${result.title}\n${result.url}`}],details:{sources}};
          return {content:[{type:'text',text:pageText(result)}],details:{sources}};
        }
      });
    }
  }
  const names=()=>pi.getActiveTools();
  function apply(next: string){
    mode=next;
    const known=new Set(pi.getAllTools().map((t: any)=>t.name));
    const local=mode==='chat'?[]:mode==='read'?readTools:fullTools;
    pi.setActiveTools([...local,...(webEnabled?webTools:[])].filter(name=>known.has(name)));
  }
  const report=(ctx: any)=>ctx.ui.notify('BOLT_STATE:'+JSON.stringify({mode,webEnabled,tools:names()}),'info');
  pi.on('session_start',()=>apply(mode!));
  pi.registerCommand('bolt-capabilities',{description:'Report app permissions',handler:async(_args: string,ctx: any)=>report(ctx)});
  pi.registerCommand('bolt-web',{description:'Set web access for this chat',handler:async(args:string,ctx:any)=>{
    webEnabled=args.trim()==='on'&&!!webUrl&&!!webKey;
    apply(mode!);
    report(ctx);
  }});
  pi.registerCommand('bolt-permissions',{description:'Apply app permissions',handler:async(args: string,ctx: any)=>{
    const [next,continuation]=args.trim().split(/\s+/);if(!modes.includes(next))throw new Error('Invalid app permission mode.');
    const previous=mode;apply(next);report(ctx);
    if(continuation==='continue'&&modes.indexOf(next)>modes.indexOf(previous!))pi.sendMessage({customType:'bolt-permissions',content:`Application permission update: ${next}. Current tools: ${names().join(', ')||'none'}. Continue the user's unfinished request using these tools. Do not repeat actions already completed successfully. Earlier assistant statements about unavailable tools may be outdated.`,display:false},{triggerTurn:true,deliverAs:'steer'});
  }});
  pi.on('before_provider_request',(event: any,ctx: any)=>{
    const tools=names();
    const section='<tools>\n'+(tools.length?tools.map((n: string)=>'- '+n).join('\n'):'(none)')+'\n</tools>';
    const notice=`\n\n<bolt_permissions>Current app permission mode: ${mode}. Available executable tools: ${tools.join(', ')||'none'}. ${mode==='chat'?(webEnabled?'Public web search and page reading are available.':'This is chat only.'):mode==='read'?'File reading and search are allowed.':mode==='ask'?'Use the tools to do the requested work; the app asks before edits or commands.':'The user enabled bypass: use the available tools to complete requested file edits and commands without another permission request.'} Current capabilities supersede earlier assistant statements about unavailable tools. Do not claim a file was saved unless a tool succeeded.</bolt_permissions>`;
    const rewrite=(s: string)=>s.replace(/<tools>[\s\S]*?<\/tools>/g,section).replace(/\n*<bolt_permissions>[\s\S]*?<\/bolt_permissions>/g,'');
    const payload={...event.payload,stream:true};
    if(process.env.BOLT_LLAMA_TIMINGS==='1'&&ctx.model?.provider==='bolt-local')payload.timings_per_token=true;
    if(process.env.BOLT_AUTO_OUTPUT==='1'&&ctx.model?.provider==='bolt-local'){delete payload.max_tokens;delete payload.max_completion_tokens;delete payload.max_output_tokens;}
    if(Array.isArray(payload.messages)){
      let first=true;payload.messages=payload.messages.map((m: any)=>{if(m.role!=='system'&&m.role!=='developer')return m;if(typeof m.content!=='string')return m;const content=rewrite(m.content)+(first?notice:'');first=false;return {...m,content};});
      if(first)payload.messages.unshift({role:'system',content:section+notice});
    }else if(typeof payload.instructions==='string')payload.instructions=rewrite(payload.instructions)+notice;
    else if(Array.isArray(payload.input)){
      let first=true;payload.input=payload.input.map((m: any)=>{
        if(m.role!=='system'&&m.role!=='developer')return m;
        const suffix=first?notice:'';first=false;
        if(typeof m.content==='string')return {...m,content:rewrite(m.content)+suffix};
        if(Array.isArray(m.content)){let appended=false;return {...m,content:m.content.map((p: any)=>{if(typeof p.text!=='string')return p;const text=rewrite(p.text)+(appended?'':suffix);appended=true;return {...p,text};})};}
        return m;
      });if(first)payload.input.unshift({role:'system',content:section+notice});
    }
    ctx.ui.notify('BOLT_REQUEST:'+JSON.stringify({mode,tools,stream:payload.stream,declaredTools:(payload.tools||[]).map((t: any)=>t.function?.name||t.name).filter(Boolean)}),'info');
    return payload;
  });
  pi.on('after_provider_response',(event: any,ctx: any)=>{
    const h=event.headers;const read=(name: string)=>typeof h?.get==='function'?h.get(name):h?.[name];
    ctx.ui.notify('BOLT_RESPONSE:'+JSON.stringify({status:event.status,contentType:read('content-type'),contentEncoding:read('content-encoding')}),'info');
  });
  pi.on('provider_stream_event',(event: any,ctx: any)=>{
    const t=event.data?.timings;if(!t||typeof t!=='object')return;
    // Preserve only numeric performance counters, never provider payloads or content.
    const timings: Record<string,number>={};
    for(const k of ['predicted_n','predicted_ms','predicted_per_second','prompt_n','prompt_ms','prompt_per_second','cache_n'])if(typeof t[k]==='number'&&Number.isFinite(t[k])&&t[k]>=0)timings[k]=t[k];
    if(Object.keys(timings).length)ctx.ui.notify('BOLT_TIMINGS:'+JSON.stringify(timings),'info');
  });
  pi.on('tool_call',async(event: any,ctx: any)=>{
    if(!names().includes(event.toolName))return {block:true,reason:`${event.toolName} is disabled in ${mode} mode.`};
    if(browserActions.includes(event.toolName)&&mode!=='bypass'&&!browserApproved){
      const allowed=await ctx.ui.confirm('Allow browser actions?',`The agent wants to ${event.toolName.replace('browser_','')} in the JoltDesk browser:\n\n${JSON.stringify(event.input,null,2)}\n\nAllowing applies to the rest of this chat. The agent can never type into password fields.`);
      if(!allowed)return {block:true,reason:'User declined browser actions.'};
      browserApproved=true;
    }
    if(!['write','edit','bash','powershell'].includes(event.toolName))return;
    if(mode!=='bypass'){
      if(mode!=='ask')return {block:true,reason:'File edits and commands are disabled in this permission mode.'};
      const allowed=await ctx.ui.confirm(`Allow ${event.toolName}?`,JSON.stringify(event.input,null,2));
      if(!allowed)return {block:true,reason:'User declined this tool action.'};
    }
    // Record the file's exact bytes before an approved edit so the app can show and undo it.
    if(event.toolName==='write'||event.toolName==='edit')ctx.ui.notify('BOLT_SNAPSHOT:'+JSON.stringify(snapshot(event.input,ctx)),'info');
    else ctx.ui.notify('BOLT_SNAPSHOT:'+JSON.stringify({command:event.toolName}),'info');
  });
  pi.registerCommand('bolt-note',{description:'Add an app note to the conversation context',handler:async(args:string)=>{
    pi.sendMessage({customType:'bolt-note',content:args.trim(),display:false});
  }});
}
