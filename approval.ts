// App-owned runtime policy. No project extensions or configuration are loaded.
export default function(pi: any) {
  const modes=['chat','read','ask','bypass'];
  let mode=modes.includes(process.env.BOLT_PERMISSION_MODE||'')?process.env.BOLT_PERMISSION_MODE:'chat';
  const readTools=['read','grep','find','ls'];
  const fullTools=['read','write','edit','bash','powershell','grep','find','ls'];
  const webUrl=process.env.BOLT_WEB_URL;
  const webKey=process.env.BOLT_WEB_KEY;
  const webTools=['web_search','browse_page'];
  let webEnabled=false;
  if(webUrl&&webKey){
    for(const tool of [
      {name:'web_search',label:'Search the web',kind:'search',field:'query',description:'Find public web pages. Use the returned source URLs to cite the answer.'},
      {name:'browse_page',label:'Read a web page',kind:'browse',field:'url',description:'Open a public URL and read its text and links. Follow a link by calling this tool with its URL.'}
    ]){
      pi.registerTool({
        name:tool.name,label:tool.label,description:tool.description,defaultActive:false,
        parameters:{type:'object',properties:{[tool.field]:{type:'string'}},required:[tool.field],additionalProperties:false},
        async execute(_id:string,input:any,signal?:AbortSignal){
          const response=await fetch(webUrl,{
            method:'POST',headers:{'Content-Type':'application/json','X-Bolt-Web-Key':webKey},
            body:JSON.stringify({kind:tool.kind,input}),signal
          });
          const result=await response.json();
          if(!response.ok)throw new Error(result.error||'Web request failed.');
          const sources=tool.kind==='search'?result.sources:[{url:result.url,title:result.title}];
          const text=tool.kind==='search'
            ?sources.map((source:any)=>source.title+'\n'+source.url+'\n'+source.snippet).join('\n\n')||'No search results.'
            :result.title+'\n'+result.url+'\n\n'+result.text+'\n\nLinks:\n'+result.links.map((link:any)=>link.title+' — '+link.url).join('\n');
          return {content:[{type:'text',text}],details:{sources}};
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
    if(!['write','edit','bash','powershell'].includes(event.toolName)||mode==='bypass')return;
    if(mode!=='ask')return {block:true,reason:'File edits and commands are disabled in this permission mode.'};
    const allowed=await ctx.ui.confirm(`Allow ${event.toolName}?`,JSON.stringify(event.input,null,2));
    if(!allowed)return {block:true,reason:'User declined this tool action.'};
  });
}
