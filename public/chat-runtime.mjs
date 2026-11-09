export function makeRuntime(chat){return {chat,messages:[],streaming:null,running:false,started:0,chars:0,usage:{},stats:{},finalSeconds:0,stage:'Working…',inspector:{files:{},tools:{}},approval:null,files:[],draft:'',followChat:true};}
export function trackTool(state,event){
  const info=state.inspector||(state.inspector={files:{},tools:{}});
  if(event.type==='tool_execution_start'){
    const paths=[event.args?.path,event.args?.file_path].filter(p=>typeof p==='string');
    for(const path of paths){const action=['write','edit'].includes(event.toolName)?'edited':'read';info.files[path]={path,action,status:'running'};info.tools[event.toolCallId]=path;}
  }
  if(event.type==='tool_execution_end'){const path=info.tools[event.toolCallId];if(path&&info.files[path])info.files[path].status=event.isError?'failed':'done';}
}
export function updateThinking(message,timing,now){if(!message||timing?.thinkingMs===undefined)return;message.thinkingDurationMs=timing.thinkingMs;message.thinkingTickAt=now;message.isThinking=!!timing.isThinking;}
export function reduceBackground(s,e,now=performance.now()){
  trackTool(s,e);
  if(e.type==='agent_start'){s.running=true;s.started=now;}
  if(e.type==='generation_start'){s.streaming={role:'assistant',content:[],model:e.model,live:true,placeholder:true,startedAt:now-(e.elapsedMs||0)};s.messages.push(s.streaming);s.stage='Processing request…';s.usage={};s.chars=0;}
  if(e.type==='message_start'&&e.message?.role==='assistant'){
    if(s.streaming?.placeholder)Object.assign(s.streaming,e.message,{live:true,placeholder:false});
    else{s.streaming={...e.message,content:[],live:true,startedAt:now-(e.timing?.elapsedMs||0)};s.messages.push(s.streaming);}
  }
  if(e.type==='generation_timing'&&s.streaming)s.streaming.serverTimings=e.timings;
  if(e.type==='message_update'){
    const a=e.assistantMessageEvent||{};if(!s.streaming){s.streaming={role:'assistant',content:[],live:true,startedAt:now};s.messages.push(s.streaming);}
    const m=s.streaming;if(e.timing?.elapsedMs!==undefined)m.startedAt=Math.min(m.startedAt,now-e.timing.elapsedMs);if(e.timing?.firstDeltaMs!=null)m.generationStartedAt=m.startedAt+e.timing.firstDeltaMs;updateThinking(m,e.timing,now);
    if(e.usage)m.usage=s.usage=e.usage;
    if(['text_delta','thinking_delta','text_end','thinking_end'].includes(a.type)){
      const thinking=a.type.startsWith('thinking'),field=thinking?'thinking':'text';const b=m.content[a.contentIndex]||(m.content[a.contentIndex]={type:thinking?'thinking':'text',[field]:''});
      b[field]=a.type.endsWith('_delta')?(b[field]||'')+a.delta:a.content;s.stage=thinking?'Thinking…':'Writing a response…';
    }
    if(a.type==='toolcall_start')m.content[a.contentIndex]={type:'toolCall',name:a.toolName,id:a.id,arguments:{},argumentText:'',isStreaming:true};
    if(a.type==='toolcall_delta'){const b=m.content[a.contentIndex]||(m.content[a.contentIndex]={type:'toolCall',arguments:{}});b.argumentText=(b.argumentText||'')+a.delta;s.stage='Writing tool arguments…';}
    if(a.type==='toolcall_end')m.content[a.contentIndex]={...a.toolCall,isStreaming:false};
  }
  if(e.type==='message_end'){
    if(e.message?.role==='assistant'){if(s.streaming)Object.assign(s.streaming,e.message,{live:false,isThinking:false,replyMetrics:e.replyMetrics});else s.messages.push({...e.message,replyMetrics:e.replyMetrics});s.streaming=null;}
    else if(e.message?.role==='toolResult')s.messages.push(e.message);
  }
  if(e.type==='tool_execution_start')s.stage='Running '+e.toolName+'…';
  if(e.type==='agent_settled'||['app_error','engine_closed'].includes(e.type)){s.running=false;s.finalSeconds=(now-s.started)/1000;if(s.streaming){s.streaming.live=false;s.streaming.isThinking=false;}s.streaming=null;if(e.message)s.error=e.message;}
  if(e.type==='stats')s.stats=e.data;
  if(e.type==='chat_updated')Object.assign(s.chat,e.chat);
  if(e.type==='permission_changed')s.chat.mode=e.mode;
  if(e.type==='extension_ui_request'&&['confirm','select','input','editor'].includes(e.method))s.approval=e;
  if(e.type==='approval_resolved')s.approval=null;
}
export function collectInspector(messages,inspector={files:{},tools:{}}){
  const files=new Map(),calls=new Map(),sources=new Map();
  for(const message of messages){
    for(const block of Array.isArray(message.content)?message.content:[]){
      if(block?.type==='toolCall'&&['write','edit','read'].includes(block.name)&&typeof block.arguments?.path==='string'){
        const file={path:block.arguments.path,action:block.name==='read'?'read':'edited',status:'pending'};
        calls.set(block.id,file);
        files.set(file.path,file);
      }
      if(block?.type==='text')for(const match of (block.text||'').matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)){
        try{const url=new URL(match[2]);sources.set(url.href,{url:url.href,title:match[1]});}catch{}
      }
    }
    if(message.role==='toolResult'){
      const file=calls.get(message.toolCallId);
      if(file)file.status=message.isError?'failed':'done';
    }
    if(message.role!=='toolResult'||!['web_search','browse_page'].includes(message.toolName))continue;
    for(const source of Array.isArray(message.details?.sources)?message.details.sources:[]){
      try{
        const url=new URL(source.url);
        if(!['http:','https:'].includes(url.protocol))continue;
        if(!sources.has(url.href))sources.set(url.href,{url:url.href,title:String(source.title||url.hostname)});
      }catch{}
    }
  }
  for(const file of Object.values(inspector.files))files.set(file.path,file);
  return {files:[...files.values()],sources:[...sources.values()]};
}
