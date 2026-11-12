// App-owned runtime policy. No project extensions or configuration are loaded.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const MAX_SNAPSHOT_BYTES=5*1024*1024;

// Shorter wording for the engine's built-in tools. Every request uses the same text,
// so the server's prompt cache still matches. Limits and editing rules are kept.
const COMPACT_TOOLS: Record<string,{description:string,parameters:Record<string,string>,items?:Record<string,string>}>={
  read:{description:'Read a text or image file. Text output stops at 2000 lines or 50KB; continue with offset and limit.',parameters:{path:'File path',offset:'First line, starting at 1',limit:'Maximum lines'}},
  write:{description:'Create or overwrite a file. Parent folders are created.',parameters:{path:'File path',content:'Full file content'}},
  edit:{description:'Replace exact text in one file. Each oldText must match a unique part of the original file and must not overlap another edit; merge nearby changes into one edit.',parameters:{path:'File path',edits:'Replacements, each matched against the original file'},items:{oldText:'Exact, unique text to replace',newText:'Replacement text'}},
  bash:{description:'Run a bash command in the working folder. Returns stdout and stderr, cut to the last 2000 lines or 50KB.',parameters:{command:'Command to run',timeout:'Timeout in seconds (optional)'}},
  powershell:{description:'Run a PowerShell command in the working folder. Returns stdout and stderr, cut to the last 2000 lines or 50KB.',parameters:{command:'Command to run',timeout:'Timeout in seconds (optional)'}},
  grep:{description:'Search file contents, respecting .gitignore. Returns path, line number and text, up to 100 matches.',parameters:{pattern:'Regex, or plain text with literal',path:'Folder or file (default: working folder)',glob:'File filter, such as *.ts or src/**/*.ts',ignoreCase:'Ignore case',literal:'Treat pattern as plain text',context:'Lines of context around each match',limit:'Maximum matches (default 100)'}},
  find:{description:'Find files by glob pattern, respecting .gitignore. Up to 1000 results.',parameters:{pattern:'Glob, such as **/*.json',path:'Folder (default: working folder)',limit:'Maximum results'}},
  ls:{description:'List a folder, including dotfiles. Folders end with /. Up to 500 entries.',parameters:{path:'Folder (default: working folder)',limit:'Maximum entries'}}
};
function compactTool(tool: any){
  const fn=tool?.function||tool;
  const compact=COMPACT_TOOLS[fn?.name];
  if(!compact||!fn.parameters?.properties)return tool;
  const properties: any={};
  for(const [key,value] of Object.entries<any>(fn.parameters.properties)){
    const next={...value};
    if(compact.parameters[key])next.description=compact.parameters[key];
    if(compact.items&&value.items?.properties){
      next.items={...value.items,properties:Object.fromEntries(Object.entries<any>(value.items.properties).map(([k,v])=>[k,compact.items![k]?{...v,description:compact.items![k]}:v]))};
    }
    properties[key]=next;
  }
  const updated={...fn,description:compact.description,parameters:{...fn.parameters,properties}};
  return tool?.function?{...tool,function:updated}:updated;
}
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
  const browserTools=['browser_open','browser_read','browser_click','browser_type','browser_press','browser_scroll','browser_screenshot'];
  const webTools=['web_search','browse_page',...browserTools];
  let webEnabled=false;
  // Clicking and typing need one approval per chat unless the user chose bypass.
  let browserApproved=false;
  const object=(properties:any,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
  const element={type:'integer',description:'Element number from the latest listing'};
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
        {name:'browser_open',label:'Open in JoltDesk browser',kind:'browser-open',parameters:object({url:{type:'string',description:'Web address, localhost URL, or full path of a local file'}},['url']),description:'Open a page or local file in JoltDesk’s browser, running its scripts. Use this instead of shell commands to open pages for inspection. Local files require Read files permission; web pages require Web. Returns page text and numbered elements.'},
        {name:'browser_read',label:'Read the browser page',kind:'browser-read',parameters:object({}),description:'Read the open page: text and numbered elements. Use it for the page the user is viewing or to refresh element numbers.'},
        {name:'browser_click',label:'Click in the browser',kind:'browser-click',parameters:object({element},['element']),description:'Click a numbered element on the open page. Returns the updated page.'},
        {name:'browser_type',label:'Type in the browser',kind:'browser-type',parameters:object({element,text:{type:'string'},submit:{type:'boolean',description:'Press Enter after typing'},clear:{type:'boolean',description:'Replace existing text (default true)'}},['element','text']),description:'Type into a numbered text field, optionally pressing Enter. Returns the updated page. Never for passwords.'},
        {name:'browser_press',label:'Press a key in the browser',kind:'browser-press',parameters:object({key:{type:'string',enum:['Enter','Tab','Escape','Backspace','Delete','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End']}},['key']),description:'Press a key on the open page. Returns the updated page.'},
        {name:'browser_scroll',label:'Scroll the browser',kind:'browser-scroll',parameters:object({direction:{type:'string',enum:['down','up']},pages:{type:'number',description:'Screens to scroll (default 1)'}},['direction']),description:'Scroll the open page. Returns the updated page.'},
        {name:'browser_screenshot',label:'Screenshot the browser',kind:'browser-screenshot',parameters:object({}),description:'Screenshot the open page to check how it looks. Needs a model that accepts images.'}
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
  // Local model servers cache the processed prompt by its prefix. For them every tool
  // stays declared in a fixed order and the system prompt never changes, so toggling
  // Web or permissions does not force the whole conversation to be processed again.
  // Permissions are enforced when a tool is called instead.
  const stableTools=process.env.BOLT_STABLE_TOOLS==='1';
  const known=()=>new Set(pi.getAllTools().map((t: any)=>t.name));
  const toolsFor=(level: string,web: boolean)=>[...(level==='chat'?[]:level==='read'?readTools:fullTools),...(web?['web_search','browse_page']:[]),...((web||level!=='chat')?browserTools:[])];
  const allowed=()=>{const k=known();return toolsFor(mode!,webEnabled).filter(name=>k.has(name));};
  // A chat declares only the tools it has needed so far, and the set never shrinks:
  // a new chat-only chat sends no tool definitions, and toggling back and forth does
  // not change the start of the prompt. The server keeps the high-water mark per chat.
  let declaredMode=modes.includes(process.env.BOLT_DECLARED_MODE||'')?process.env.BOLT_DECLARED_MODE!:'chat';
  let declaredWeb=process.env.BOLT_DECLARED_WEB==='1';
  const declared=()=>{const k=known();return toolsFor(declaredMode,declaredWeb).filter(name=>k.has(name));};
  const names=allowed;
  function apply(next: string){
    mode=next;
    if(modes.indexOf(next)>modes.indexOf(declaredMode))declaredMode=next;
    if(webEnabled)declaredWeb=true;
    pi.setActiveTools(stableTools?declared():allowed());
  }
  const report=(ctx: any)=>ctx.ui.notify('BOLT_STATE:'+JSON.stringify({mode,webEnabled,tools:names(),declaredMode,declaredWeb}),'info');
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
    const listed=stableTools?declared():tools;
    const section='<tools>\n'+(listed.length?listed.map((n: string)=>'- '+n).join('\n'):'(none)')+'\n</tools>';
    const notice=`\n\n<bolt_permissions>Current app permission mode: ${mode}. Available executable tools: ${tools.join(', ')||'none'}. ${mode==='chat'?(webEnabled?'Public web search and page reading are available.':'This is chat only.'):mode==='read'?'File reading and search are allowed.':mode==='ask'?'Use the tools to do the requested work; the app asks before edits or commands.':'The user enabled bypass: use the available tools to complete requested file edits and commands without another permission request.'} Use browser_open and browser_screenshot to inspect pages, not shell commands that launch an external browser. When an attachment supplies a path, use that exact path for file tools. Current capabilities supersede earlier assistant statements about unavailable tools. Do not claim a file was saved unless a tool succeeded.</bolt_permissions>`;
    // Pi's documentation pointers only help when asking about the harness itself.
    const rewrite=(s: string)=>s.replace(/<tools>[\s\S]*?<\/tools>/g,section).replace(/\n*<bolt_permissions>[\s\S]*?<\/bolt_permissions>/g,'').replace(/\n*<docs>[\s\S]*?<\/docs>/g,'');
    if(stableTools&&Array.isArray(event.payload?.messages)){
      // The system prompt stays identical; the current permissions go at the end.
      const fixed='\n\n<bolt_permissions>The app decides which of the listed tools may run, and the user can change that during the chat. The <bolt_permission_state> note at the end of the latest message is current and overrides anything earlier. A call to a tool that is not allowed is blocked with a reason. Do not claim a file was saved unless a tool succeeded.</bolt_permissions>';
      const state='\n\n<bolt_permission_state>'+notice.trim().replace(/^<bolt_permissions>|<\/bolt_permissions>$/g,'')+'</bolt_permission_state>';
      const payload={...event.payload,stream:true};
      if(Array.isArray(payload.tools))payload.tools=payload.tools.map(compactTool);
      if(process.env.BOLT_LLAMA_TIMINGS==='1'){payload.timings_per_token=true;payload.return_progress=true;}
      if(process.env.BOLT_AUTO_OUTPUT==='1'){delete payload.max_tokens;delete payload.max_completion_tokens;delete payload.max_output_tokens;}
      let first=true;
      payload.messages=payload.messages.map((m: any)=>{if(m.role!=='system'&&m.role!=='developer')return m;if(typeof m.content!=='string')return m;const content=rewrite(m.content)+(first?fixed:'');first=false;return {...m,content};});
      if(first)payload.messages.unshift({role:'system',content:section+fixed});
      const last=payload.messages.length-1,tail=payload.messages[last];
      if(tail&&tail.role!=='system'&&tail.role!=='developer'){
        const content=typeof tail.content==='string'?tail.content+state:Array.isArray(tail.content)?[...tail.content,{type:'text',text:state.trim()}]:state.trim();
        payload.messages[last]={...tail,content};
      }
      ctx.ui.notify('BOLT_REQUEST:'+JSON.stringify({mode,tools,stream:payload.stream,declaredTools:(payload.tools||[]).map((t: any)=>t.function?.name||t.name).filter(Boolean)}),'info');
      return payload;
    }
    const payload={...event.payload,stream:true};
    if(Array.isArray(payload.tools))payload.tools=payload.tools.map(compactTool);
    // llama.cpp servers stream prompt_progress chunks while they read a long prompt.
    if(process.env.BOLT_LLAMA_TIMINGS==='1'&&ctx.model?.provider==='bolt-local'){payload.timings_per_token=true;payload.return_progress=true;}
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
    const progress=event.data?.prompt_progress;
    if(progress&&typeof progress==='object'){
      // Only numeric counters leave the engine, never prompt content.
      const counts: Record<string,number>={};
      for(const k of ['total','cache','processed','time_ms'])if(typeof progress[k]==='number'&&Number.isFinite(progress[k])&&progress[k]>=0)counts[k]=progress[k];
      if(counts.total>0)ctx.ui.notify('BOLT_PROGRESS:'+JSON.stringify(counts),'info');
    }
    const t=event.data?.timings;if(!t||typeof t!=='object')return;
    // Preserve only numeric performance counters, never provider payloads or content.
    const timings: Record<string,number>={};
    for(const k of ['predicted_n','predicted_ms','predicted_per_second','prompt_n','prompt_ms','prompt_per_second','cache_n'])if(typeof t[k]==='number'&&Number.isFinite(t[k])&&t[k]>=0)timings[k]=t[k];
    if(Object.keys(timings).length)ctx.ui.notify('BOLT_TIMINGS:'+JSON.stringify(timings),'info');
  });
  pi.on('tool_call',async(event: any,ctx: any)=>{
    if(!names().includes(event.toolName))return {block:true,reason:`${event.toolName} is not allowed right now. The chat is in ${mode} mode${webEnabled?'':' with Web off'}. Ask the user to change the permission${webTools.includes(event.toolName)?' or turn on Web':''} if this tool is needed.`};
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
