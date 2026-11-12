export const LOCAL_PROVIDER='bolt-local';
export const ASSUMED_CONTEXT=131072;
export const OPENAI_CONNECTION={provider:'openai',baseUrl:'https://api.openai.com/v1',autoConnect:true};
export function normalizeBaseUrl(value){
  let u;try{u=new URL(String(value||'').trim());}catch{throw new Error('Enter a complete API URL, such as http://127.0.0.1:8080/v1.');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Use an HTTP(S) base URL without a password, query, or fragment. Put the key in the API key field.');
  u.pathname=u.pathname.replace(/\/+$/,'').replace(/\/(chat\/completions|responses|models)$/,'')||'/v1';
  return u.toString().replace(/\/$/,'');
}
export function optionalInteger(value,label,min=1,max=10000000){
  if(value===''||value===null||value===undefined)return null;
  const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${label} must be a whole number between ${min} and ${max}.`);return n;
}
export function credentialId(connection){return connection.provider==='local'?'local@'+connection.baseUrl:'openai';}
// Unsloth Studio reports the loaded model's runtime context at /v1/status.
// The value applies only to the model it names, never to other listed models.
export function studioContextFor(status,model){
  if(!status||typeof status!=='object')return null;
  const names=[model.id,model.name,model.root].filter(Boolean);
  const loaded=[status.model_identifier,status.active_model].filter(Boolean);
  if(!loaded.some(name=>names.includes(name)))return null;
  const value=Number(status.context_length);
  return Number.isInteger(value)&&value>0?value:null;
}
export function studioVisionFor(status,model){
  if(!status||typeof status!=='object')return null;
  const names=[model.id,model.name,model.root].filter(Boolean);
  if(![status.model_identifier,status.active_model].filter(Boolean).some(name=>names.includes(name)))return null;
  return typeof status.is_vision==='boolean'?status.is_vision:null;
}
export async function studioStatus(connection,key,fetcher=fetch){
  const base=normalizeBaseUrl(connection.baseUrl);
  try{
    const r=await fetcher(base+'/status',{headers:key?{Authorization:`Bearer ${key}`}:{},redirect:'error',signal:AbortSignal.timeout(8000)});
    return r.ok?await r.json():null;
  }catch{return null;}
}
export async function discoverLocal(connection,key,fetcher=fetch){
  const base=normalizeBaseUrl(connection.baseUrl),headers=key?{Authorization:`Bearer ${key}`}:{},root=base.replace(/\/v1$/,'');
  const request=async url=>{
    let r;try{r=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new Error(`Cannot reach ${url}. Check the URL and start your model server.`);}
    if(!r.ok)throw new Error(r.status===401||r.status===403?'The model server rejected the API key.':`The model server returned ${r.status} for ${url}.`);
    return r.json();
  };
  const payload=await request(base+'/models');
  const listed=Array.isArray(payload.data)?payload.data:Array.isArray(payload.models)?payload.models:[];
  const compatible=listed.filter(m=>m&&typeof (m.id||m.name)==='string'&&!/embed|rerank|whisper|tts/i.test(m.id||m.name));
  // Splash advertises its resident model twice: a canonical ID and a friendly alias
  // whose root names that same resident model. Prefer the alias in the picker.
  const aliases=new Map();
  for(const m of compatible)if(m.owned_by==='splash'&&m.root&&m.root!==m.id&&compatible.some(c=>c.id===m.root&&c.owned_by==='splash')){
    if(!aliases.has(m.root)||m.id==='qwen-local')aliases.set(m.root,m.id);
  }
  const raw=compatible.filter(m=>!aliases.has(m.id)&&(!aliases.has(m.root)||aliases.get(m.root)===m.id));
  if(!raw.length)throw new Error('The API returned no chat models. Load Qwen in the server and reconnect.');
  let props={};if(connection.profile!=='generic')try{props=await request(root+'/props');}catch{}
  const ctxOverride=optionalInteger(connection.contextWindow==='auto'?null:connection.contextWindow,'Context window',256),autoOutput=connection.maxTokens==='auto'||connection.maxTokens==null||connection.maxTokens==='',maxOverride=optionalInteger(autoOutput?null:connection.maxTokens,'Max output tokens');
  if(ctxOverride&&maxOverride&&maxOverride>ctxOverride)throw new Error('Max output tokens cannot exceed the context window.');
  const estimates={};
  const modelProps=new Map();
  if(connection.profile!=='generic'&&raw.length>1)await Promise.all(raw.map(async m=>{try{const p=await request(root+'/props?model='+encodeURIComponent(m.id||m.name)+'&autoload=false');modelProps.set(m.id||m.name,p);}catch{}}));
  // Older Splash versions implement efforts but omit the reasoning catalog.
  // Render a tiny fixed template without inference and keep only distinct levels.
  const legacyEfforts=new Map();
  await Promise.all(raw.filter(m=>m.owned_by==='splash'&&!m.reasoning).map(async m=>{
    const rendered=await Promise.all(['low','medium','xhigh'].map(async effort=>{try{
      const r=await fetcher(root+'/apply-template',{method:'POST',headers:{...headers,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),body:JSON.stringify({model:m.id||m.name,messages:[{role:'user',content:'Hello'}],reasoning_effort:effort})});
      if(!r.ok)return null;const p=await r.json();return typeof p.prompt==='string'?{effort,prompt:p.prompt}:null;
    }catch{return null;}}));
    if(rendered.every(Boolean)&&new Set(rendered.map(p=>p.prompt)).size===3)legacyEfforts.set(m.id||m.name,rendered.map(p=>p.effort));
  }));
  const studio=raw.some(m=>m.owned_by==='unsloth-studio')?await studioStatus(connection,key,fetcher):null;
  // Unsloth Studio does not list image support in /v1/models, so ask its vision check.
  // Model IDs contain a slash, so try the encoded form and then the plain path.
  const studioVision=new Map();
  await Promise.all(raw.filter(m=>m.owned_by==='unsloth-studio').map(async m=>{
    const id=m.id||m.name;
    for(const name of [encodeURIComponent(id),id]){
      try{const r=await request(root+'/api/models/check-vision/'+name);if(typeof r?.is_vision==='boolean'){studioVision.set(id,r.is_vision);return;}}catch{}
    }
  }));
  const thinkingTokenBudget=optionalInteger(connection.thinkingTokenBudget,'Thinking token budget',0);
  const models=raw.map(m=>{
    const id=m.id||m.name;
    const reportedProps=modelProps.get(id)||(raw.length===1?props:{});
    // Some routers ignore ?model= and return the resident model's properties.
    // Never let its template, image support or context leak into a different model.
    const p=reportedProps.model_alias&&![id,m.name,m.root,...(Array.isArray(m.aliases)?m.aliases:[])].includes(reportedProps.model_alias)?{}:reportedProps;
    const unsloth=m.owned_by==='unsloth-studio';
    // Studio's OpenAI catalog can omit reasoning flags even though its Qwen3.8
    // template supports the documented low/medium/xhigh efforts. Explicit
    // server metadata takes precedence, including an empty list (on/off only).
    const unslothEfforts=Array.isArray(m.reasoning_effort_levels)?m.reasoning_effort_levels:Array.isArray(p.reasoning_effort_levels)?p.reasoning_effort_levels:Array.isArray(p.chat_template_caps?.reasoning_effort_levels)?p.chat_template_caps.reasoning_effort_levels:
      unsloth&&m.supports_reasoning!==false&&p.supports_reasoning!==false&&/qwen3[._-]8(?:[-:/]|$)/i.test(id+' '+(m.root||''))?['low','medium','xhigh']:undefined;
    const detected=optionalInteger((unsloth?studioContextFor(studio,{id,name:m.name,root:m.root}):null)||p.default_generation_settings?.n_ctx||p.n_ctx||m.meta?.n_ctx||m.context_window||m.context_length||m.contextWindow||m.max_model_len||null,'Reported context',1);
    const native=optionalInteger(m.native_context_length||m.meta?.n_ctx_train||null,'Native context',1);
    // An unknown window must not be guessed small: the engine compacts at about 90%
    // of it, and each compaction resends the whole conversation. With a generous
    // assumption, a real overflow from the server triggers the engine's recovery instead.
    const contextWindow=ctxOverride||detected||native||Math.max(ASSUMED_CONTEXT,maxOverride||0);
    const maxTokens=autoOutput?contextWindow:maxOverride||Math.min(4096,Math.max(1,Math.floor(contextWindow/2)));
    if(maxTokens>contextWindow)throw new Error(`Max output tokens exceeds the context window for ${id}. Set a context window explicitly.`);
    const reasoning=connection.thinking==='on'||connection.thinking!=='off'&&(
      m.reasoning===true||m.reasoning?.thinks===true||m.reasoning?.efforts?.length>0||m.supports_reasoning===true||p.supports_reasoning===true||unslothEfforts?.length>0||/enable_thinking|<think>/.test(p.chat_template||'')||(/qwen3|qwq|deepseek.*r1|gpt-oss/i.test(id+' '+(m.root||''))&&!/coder|instruct-2507/i.test(id)));
    const llama=connection.profile!=='generic';
    const capabilities=Array.isArray(m.capabilities)?m.capabilities.map(String):[];
    const vision=p.modalities?.vision||m.vision===true||m.input_modalities?.includes('image')||m.input?.includes('image')||
      capabilities.some(c=>/^(vision|image|images|image_input)$/i.test(c))||
      (unsloth&&(studioVisionFor(studio,{id,name:m.name,root:m.root})??studioVision.get(id)??/(^|[-_/])VL([-_.]|$)/i.test(id)));
    const model={id,name:m.name||id,reasoning,input:vision?['text','image']:['text'],
      contextWindow,maxTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
      compat:{maxTokensField:'max_tokens',supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,supportsUsageInStreaming:true,supportsStrictMode:false}};
    if(reasoning){
      model.thinkingLevelMap={off:'none',minimal:null,low:null,medium:'medium',high:null,xhigh:null,max:null};
      if(llama){
        model.samplingParams={reasoning_format:'deepseek'};
        model.samplingParamsByThinkingLevel={off:{chat_template_kwargs:{enable_thinking:false}},medium:{chat_template_kwargs:{enable_thinking:true}}};
      }
      if(unsloth)model.samplingParamsByThinkingLevel={off:{enable_thinking:false,chat_template_kwargs:{enable_thinking:false}},medium:{enable_thinking:true,chat_template_kwargs:{enable_thinking:true}}};
      const advertised=Array.isArray(m.reasoning?.efforts)?m.reasoning.efforts:unslothEfforts??legacyEfforts.get(id);
      const efforts=advertised?.filter(l=>['minimal','low','medium','high','xhigh','max'].includes(l));
      if(efforts?.length){
        model.thinkingLevelMap=Object.fromEntries(['off','minimal','low','medium','high','xhigh','max'].map(l=>[l,l==='off'?'none':efforts.includes(l)?l:null]));
        model.samplingParamsByThinkingLevel=Object.fromEntries(['off',...efforts].map(l=>[l,{reasoning_effort:l==='off'?'none':l,...(unsloth?{enable_thinking:l!=='off'}:{}),chat_template_kwargs:{enable_thinking:l!=='off',...(unsloth&&l!=='off'?{reasoning_effort:l}:{})}}]));
      }
      if(thinkingTokenBudget!==null&&m.owned_by==='splash')model.samplingParams={...model.samplingParams,thinking_token_budget:thinkingTokenBudget};
    }
    estimates[id]=!ctxOverride&&!detected;return model;
  });
  return {baseUrl:base,estimates,splashModels:raw.filter(m=>m.owned_by==='splash').map(m=>m.id||m.name),studioModels:raw.filter(m=>m.owned_by==='unsloth-studio').map(m=>m.id||m.name),definition:{baseUrl:base,api:'openai-completions',apiKey:'$BOLT_LOCAL_API_KEY',authHeader:true,headers:{Accept:'text/event-stream','Accept-Encoding':'identity','Cache-Control':'no-cache'},models},note:ctxOverride?'Using your context window override.':Object.values(estimates).some(Boolean)?'Some models do not advertise a running context limit. Sizes marked ~ are estimates. Load the model and reconnect to refresh, or enter a context window.':'Context window detected from the server.'};
}
