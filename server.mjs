import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rpc, findBinary } from './rpc.mjs';
import { EngineManager } from './engine-updater.mjs';
import { LOCAL_PROVIDER, OPENAI_CONNECTION, normalizeBaseUrl, optionalInteger, credentialId, discoverLocal } from './connections.mjs';
import { completedMetrics } from './public/reply-metrics.mjs';
import {makeRuntime,reduceBackground,collectInspector} from './public/chat-runtime.mjs';
import { createCheckpoints } from './checkpoints.mjs';
import * as gitOps from './git.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export async function startServer({port=0,dataDir=path.join(root,'.bolt-data'),vault,native,engineDir,requireBundled=false,autoStartUpdates=true,updateFetcher}={}) {
  await fs.mkdir(dataDir,{recursive:true});
  const agentDir=path.join(dataDir,'agent'),sessionDir=path.join(dataDir,'sessions');
  await fs.mkdir(agentDir,{recursive:true});await fs.mkdir(sessionDir,{recursive:true});
  await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({defaultProjectTrust:'never',enableTelemetry:false}));
  let key='',models=[],connected=false,connectionError=null,connectionNote='',meta={projects:[],chats:[],binary:''},secrets={};
  const stored=await vault?.get()||'';
  if(stored){try{const parsed=JSON.parse(stored);if(parsed.version===2)secrets=parsed.keys||{};}catch{secrets.openai=stored;}}
  const sessionKeys={...secrets};
  try{meta={...meta,...JSON.parse(await fs.readFile(path.join(dataDir,'workspace.json'),'utf8'))};}catch{}
  meta.chats=meta.chats.filter(c=>!meta.deletedChatIds?.includes(c.id));
  let recovered=false;
  for(const file of await fs.readdir(sessionDir)){
    const id=/_([a-zA-Z0-9][a-zA-Z0-9._-]*)\.jsonl$/.exec(file)?.[1];
    if(!id||meta.deletedChatIds?.includes(id)||meta.chats.some(c=>c.id===id))continue;
    try{
      const rows=(await fs.readFile(path.join(sessionDir,file),'utf8')).split('\n').slice(0,250).filter(Boolean).map(l=>JSON.parse(l));
      const head=rows.find(r=>r.type==='session'),first=rows.find(r=>r.message?.role==='user');if(!first||head?.id!==id)continue;
      const text=typeof first.message.content==='string'?first.message.content:first.message.content.filter(c=>c.type==='text').map(c=>c.text).join(' ');
      const model=rows.filter(r=>r.type==='model_change').at(-1)?.modelId;
      const thinking=rows.filter(r=>r.type==='thinking_level_change').at(-1)?.thinkingLevel;
      meta.chats.unshift({id,title:text.slice(0,55)||'Recovered conversation',projectId:meta.projects.find(p=>p.path===head.cwd)?.id||null,mode:'ask',model,thinking,createdAt:Date.parse(head.timestamp)||Date.now(),recovered:true});recovered=true;
    }catch{}
  }
  let connection=meta.connection||{...OPENAI_CONNECTION};
  if(connection.provider==='local')connection.baseUrl=normalizeBaseUrl(connection.baseUrl);
  const connectionName=c=>c.provider==='openai'?'OpenAI':new URL(c.baseUrl).hostname;
  const legacyConnections=!Array.isArray(meta.connections);let migratedConnections=legacyConnections;
  if(legacyConnections)meta.connections=[];
  if(legacyConnections&&meta.connection&&!meta.connections.some(c=>c.id===connection.id||credentialId(c)===credentialId(connection))){connection={...connection,id:randomUUID(),name:connection.name||connectionName(connection)};meta.connections.push({...connection,models:[]});}
  for(const endpoint of Object.keys(secrets)){
    if(endpoint!=='openai'&&!endpoint.startsWith('local@'))continue;
    try{const c=endpoint==='openai'?{...OPENAI_CONNECTION}:{provider:'local',baseUrl:normalizeBaseUrl(endpoint.slice(6)),profile:'llamacpp',thinking:'auto',autoConnect:true};
      if(!meta.connections.some(p=>credentialId(p)===credentialId(c))){meta.connections.push({...c,id:randomUUID(),name:connectionName(c),models:[],recovered:true});migratedConnections=true;}
    }catch{}
  }
  const activeProfile=meta.connections.find(c=>c.id===connection.id||credentialId(c)===credentialId(connection));
  if(activeProfile){connection={...connection,id:activeProfile.id,name:activeProfile.name};meta.connection=connection;for(const chat of meta.chats)if(!chat.connectionId){chat.connectionId=connection.id;migratedConnections=true;}}
  for(const c of meta.connections)if(c.provider==='local'&&(c.maxTokens==null||c.maxTokens==='')){c.maxTokens='auto';migratedConnections=true;}
  if(connection.provider==='local'&&(connection.maxTokens==null||connection.maxTokens==='')){connection.maxTokens='auto';meta.connection=connection;migratedConnections=true;}
  key=secrets[credentialId(connection)]||'';
  let engine;
  const bundledDir=engineDir||path.join(root,'engine-bundle');
  const hasBundle=await fs.access(path.join(bundledDir,'bundle-meta.json')).then(()=>true,()=>false);
  if(requireBundled&&!hasBundle)throw new Error('The bundled engine is missing. Reinstall JoltDesk.');
  if(hasBundle){
    engine=await new EngineManager({bundledDir,dataDir,fetcher:updateFetcher,verifyEngine:async binary=>{
      const rpc=new Rpc({binary,cwd:dataDir,agentDir,sessionDir,sessionId:'engine-health',mode:'chat'});
      try{
        const state=await rpc.command('get_state');const catalog=await rpc.command('get_available_models');
        if(!state.sessionId||!Array.isArray(catalog.models))throw new Error('Updated engine is incompatible with this GUI.');
        await rpc.command('get_available_thinking_levels');
      }finally{if(!rpc.closed)await new Promise(resolve=>{rpc.child.once('close',resolve);rpc.close();});}
    }}).init();
  }
  const selectedBinary=()=>meta.binary?findBinary(meta.binary):engine?.binary()||findBinary();
  let saveQueue=Promise.resolve();
  const save=()=>{saveQueue=saveQueue.catch(()=>{}).then(async()=>{
    try{const disk=JSON.parse(await fs.readFile(path.join(dataDir,'workspace.json'),'utf8'));meta.deletedChatIds=[...new Set([...(meta.deletedChatIds||[]),...(disk.deletedChatIds||[])])];const ids=new Set(meta.chats.map(c=>c.id));meta.chats.push(...(disk.chats||[]).filter(c=>!ids.has(c.id)));}catch{}
    meta.chats=meta.chats.filter(c=>!meta.deletedChatIds?.includes(c.id));
    const file=path.join(dataDir,'workspace.json'),temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(meta,null,2));await fs.rename(temporary,file);
  });return saveQueue;};
  if(recovered||migratedConnections)await save();
  const token=randomBytes(32).toString('hex'),app=express(),http=createServer(app),wss=new WebSocketServer({noServer:true});
  const runners=new Map(),subscribers=new Map(),starting=new Map();
  const metricsDir=path.join(dataDir,'reply-metrics');await fs.mkdir(metricsDir,{recursive:true});
  const checkpoints=createCheckpoints(path.join(dataDir,'checkpoints'));
  const restoreNotes=new Map();
  const chatCwd=chat=>meta.projects.find(project=>project.id===chat.projectId)?.path||path.join(dataDir,'workspace');
  // Closes the running turn's checkpoint and tells open windows to refresh Changes.
  const finishTurn=(chatId,rpc)=>{
    const turn=rpc.turn;if(!turn)return;rpc.turn=null;
    checkpoints.finish(turn).then(()=>broadcast(chatId,{type:'checkpoints_changed'})).catch(()=>{});
  };
  const metricCache=new Map(),metricWrites=new Map();
  async function replyMetrics(id){if(!metricCache.has(id)){try{metricCache.set(id,JSON.parse(await fs.readFile(path.join(metricsDir,id+'.json'),'utf8')));}catch{metricCache.set(id,{});}}return metricCache.get(id);}
  let auditQueue=Promise.resolve();
  const audit=(event)=>{auditQueue=auditQueue.then(async()=>{const file=path.join(dataDir,'diagnostics.jsonl');try{if((await fs.stat(file)).size>2000000)await fs.rename(file,path.join(dataDir,'diagnostics.previous.jsonl'));}catch{}await fs.appendFile(file,JSON.stringify({at:new Date().toISOString(),...event})+'\n');}).catch(()=>{});};
  const broadcast=(id,event)=>{const rpc=runners.get(id);if(rpc){event.seq=++rpc.eventSeq;if(rpc.viewState)reduceBackground(rpc.viewState,event);}for(const ws of subscribers.get(id)||[]) if(ws.readyState===1)ws.send(JSON.stringify(event));};
  const endpointStatuses=new Map(),endpointChecks=new Map();
  const config=()=>({connected,connection,connections:meta.connections.map(c=>({...c,status:endpointStatuses.get(c.id)||{state:'saved'},hasSavedKey:!!secrets[credentialId(c)],hasSessionKey:!!sessionKeys[credentialId(c)]})),runningChats:[...runners].filter(([,r])=>r.busy).map(([id])=>id),connectionError,connectionNote,preferredModel:meta.preferredModels?.[credentialId(connection)]||null,hasSavedKey:!!secrets[credentialId(connection)],secureStorage:!!vault,models,projects:meta.projects,chats:meta.chats,binary:selectedBinary(),native:!!native,webAvailable:!!native?.webTools,browserAvailable:!!native?.browser,engine:engine?.status()||null,customEngine:!!meta.binary});
  function rememberProfile(){if(!connection.id)return;const i=meta.connections.findIndex(c=>c.id===connection.id);const p={...connection,models};if(i<0)meta.connections.push(p);else meta.connections[i]=p;meta.connection=connection;if(connected)endpointStatuses.set(connection.id,{state:'connected',checkedAt:Date.now()});}
  async function checkEndpoint(profile){
    if(endpointChecks.has(profile.id))return endpointChecks.get(profile.id);
    const old=endpointStatuses.get(profile.id);if(old?.checkedAt&&Date.now()-old.checkedAt<30000)return old;
    const scope=credentialId(profile),candidate=sessionKeys[scope]||'';
    const task=(async()=>{let state='unavailable';try{
      const r=await fetch(profile.baseUrl+'/models',{headers:candidate?{Authorization:'Bearer '+candidate}:{},redirect:'error',signal:AbortSignal.timeout(8000)});
      if(r.status===401||r.status===403)state=candidate?'check-key':'key-required';
      else if(r.ok){const data=await r.json();if(Array.isArray(data.data)||Array.isArray(data.models))state='connected';}
    }catch{}
    const status={state,checkedAt:Date.now()};if(meta.connections.some(c=>c.id===profile.id)&&(sessionKeys[scope]||'')===candidate)endpointStatuses.set(profile.id,status);return status;
    })();endpointChecks.set(profile.id,task);try{return await task;}finally{endpointChecks.delete(profile.id);}
  }
  let changingConnection=false;
  async function changeConnection(work){
    if(changingConnection)throw new Error('An API connection is already changing. Try again in a moment.');
    changingConnection=true;try{return await work();}finally{changingConnection=false;}
  }
  async function activateConnection(profile){
    const {models:cached,...target}=profile;const candidate=sessionKeys[credentialId(target)]||'';
    const result=await connectionModels(target,candidate);
    if(!result.models.length)throw new Error('No compatible chat models found.');
    connection={...target,revision:(target.revision||0)+1,autoConnect:true};key=candidate;models=result.models;connectionNote=result.note;connectionError=null;connected=true;rememberProfile();await save();
  }
  engine?.subscribe(status=>{for(const id of subscribers.keys())broadcast(id,{type:'engine_status',engine:status});});
  async function discover(apiKey,provider='openai') {
    if(engine?.state.installing)throw new Error('The engine is updating. Try again when it finishes.');
    const rpc=new Rpc({binary:selectedBinary(),cwd:dataDir,agentDir,sessionDir,sessionId:'discovery',key:apiKey});
    try {const result=await rpc.command('get_available_models');return result.models.filter(m=>m.provider===provider);}finally{rpc.close();}
  }
  async function accountModels(candidate) {
    const response=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${candidate}`},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`OpenAI rejected the connection (${response.status}). Check your key and API account.`);
    const available=new Set((await response.json()).data.map(m=>m.id));
    return (await discover(candidate)).filter(m=>available.has(m.id)&&(!m.type||m.type==='chat')).sort((a,b)=>(b.reasoning-a.reasoning)||b.id.localeCompare(a.id,undefined,{numeric:true}));
  }
  async function connectionModels(target,candidate){
    if(target.provider!=='local'){
      if(!candidate)throw new Error('Paste your OpenAI API key.');
      return {models:await accountModels(candidate),note:''};
    }
    const local=await discoverLocal(target,candidate);
    const modelFile=path.join(agentDir,'models.json');let original=null,parsed={};
    try{original=await fs.readFile(modelFile,'utf8');parsed=JSON.parse(original);}catch{}
    parsed.providers={...parsed.providers,[LOCAL_PROVIDER]:local.definition};
    await fs.writeFile(modelFile,JSON.stringify(parsed,null,2));
    try{
      const catalog=await discover(candidate,LOCAL_PROVIDER);
      if(!catalog.length)throw new Error('No compatible chat models found. The previous API is unchanged.');
      return {models:catalog.map(m=>({...m,contextWindowEstimated:local.estimates[m.id],splashThinkingBudget:!!m.reasoning&&local.splashModels.includes(m.id)})),note:local.note};
    }catch(e){if(original!==null)await fs.writeFile(modelFile,original);else await fs.rm(modelFile,{force:true});throw e;}
  }
  async function runner(chat) {
    if(meta.deletedChatIds?.includes(chat.id))throw new Error('This chat has been deleted.');
    if(engine?.state.installing)throw new Error('The engine is updating. Try again when it finishes.');
    const profile=chat.connectionId?meta.connections.find(c=>c.id===chat.connectionId):{...connection,models};
    if(!profile)throw new Error('This chat’s API was removed. Select another API to continue.');
    const existing=runners.get(chat.id);
    if(existing&&(existing.busy||(existing.boundConnection.id===profile.id&&existing.profileRevision===(profile.revision||0))))return existing;
    if(existing){existing.close();runners.delete(chat.id);}
    if(starting.has(chat.id))return starting.get(chat.id);
    const promise=(async()=>{
      const project=meta.projects.find(p=>p.id===chat.projectId);
      const cwd=project?.path || path.join(dataDir,'workspace');await fs.mkdir(cwd,{recursive:true});
      const extension=process.env.BOLT_APPROVAL_PATH || path.join(root,'approval.ts');
      const candidate=sessionKeys[credentialId(profile)]||'';
      // Each chat owns its registry and credential environment. Changing the picker
      // must never redirect a running chat, even when both APIs use the same model ID.
      const isolatedAgentDir=path.join(dataDir,'runners',chat.id,'agent');await fs.mkdir(isolatedAgentDir,{recursive:true});
      let registry={};try{registry=JSON.parse(await fs.readFile(path.join(agentDir,'models.json'),'utf8'));}catch{}
      let profileModels=profile.models||[];
      if(profile.provider==='local'){
        const fields=['id','name','reasoning','input','contextWindow','maxTokens','cost','compat','thinkingLevelMap','samplingParams','samplingParamsByThinkingLevel'];
        let definition;
        if(profileModels.length)definition={baseUrl:profile.baseUrl,api:'openai-completions',apiKey:'$BOLT_LOCAL_API_KEY',authHeader:true,headers:{Accept:'text/event-stream','Accept-Encoding':'identity','Cache-Control':'no-cache'},models:profileModels.map(m=>Object.fromEntries(fields.filter(k=>m[k]!==undefined).map(k=>[k,m[k]])))};
        else {const discovered=await discoverLocal(profile,candidate);definition=discovered.definition;profileModels=definition.models.map(m=>({...m,provider:LOCAL_PROVIDER}));}
        registry.providers={...registry.providers,[LOCAL_PROVIDER]:definition};
      }
      await fs.writeFile(path.join(isolatedAgentDir,'models.json'),JSON.stringify(registry));await fs.copyFile(path.join(agentDir,'settings.json'),path.join(isolatedAgentDir,'settings.json'));
      const webAccess=native?.webTools?{url:`http://127.0.0.1:${http.address().port}/internal/chats/${chat.id}/web`,key:randomBytes(32).toString('hex'),browser:!!native.browser}:undefined;
      const rpc=new Rpc({binary:selectedBinary(),cwd,agentDir:isolatedAgentDir,sessionDir,sessionId:chat.id,key:candidate,mode:chat.mode,extension,serverTimings:profile.provider==='local'&&profile.profile!=='generic',autoOutput:profile.provider==='local'&&profile.maxTokens==='auto',webAccess});
      rpc.webKey=webAccess?.key;
      rpc.webPending=0;
      rpc.boundConnection={...profile};rpc.models=profileModels;rpc.profileRevision=profile.revision||0;rpc.keySnapshot=candidate;
      rpc.viewState=makeRuntime(chat);rpc.eventSeq=0;
      rpc.busy=false;
      rpc.on('event',e=>{
        if(e.type==='extension_ui_request'&&e.method==='notify'&&e.message?.startsWith('BOLT_STATE:')){rpc.capabilities=JSON.parse(e.message.slice(11));audit({type:'permissions',chatId:chat.id,...rpc.capabilities});broadcast(chat.id,{type:'capabilities',...rpc.capabilities});return;}
        if(e.type==='extension_ui_request'&&e.method==='notify'&&e.message?.startsWith('BOLT_REQUEST:')){
          rpc.requestStarted=performance.now();rpc.requestStartedAt=Date.now();rpc.deltaCount=0;rpc.firstDelta=null;rpc.lastDelta=null;rpc.serverTimings=null;rpc.thinkingStart=null;rpc.thinkingMs=0;
          audit({type:'model_request',chatId:chat.id,...JSON.parse(e.message.slice(13))});
          broadcast(chat.id,{type:'generation_start',model:chat.model,elapsedMs:0,requestStartedAt:rpc.requestStartedAt});return;
        }
        if(e.type==='extension_ui_request'&&e.method==='notify'&&e.message?.startsWith('BOLT_RESPONSE:')){audit({type:'provider_response',chatId:chat.id,elapsedMs:rpc.requestStarted?performance.now()-rpc.requestStarted:null,...JSON.parse(e.message.slice(14))});return;}
        if(e.type==='extension_ui_request'&&e.method==='notify'&&e.message?.startsWith('BOLT_SNAPSHOT:')){if(rpc.turn){try{checkpoints.snapshot(rpc.turn,JSON.parse(e.message.slice(14))).catch(()=>{});}catch{}}return;}
        if(e.type==='extension_ui_request'&&e.method==='notify'&&e.message?.startsWith('BOLT_TIMINGS:')){rpc.serverTimings=JSON.parse(e.message.slice(13));broadcast(chat.id,{type:'generation_timing',timings:rpc.serverTimings});return;}
        if(e.type==='extension_ui_request'&&e.method==='confirm')rpc.pendingApproval=e.id;
        if(e.type==='message_start'&&e.message?.role==='assistant'){rpc.messageStarted=rpc.requestStarted??performance.now();e.timing={elapsedMs:performance.now()-rpc.messageStarted};}
        if(e.type==='message_update'){
          const elapsedMs=performance.now()-(rpc.requestStarted??rpc.messageStarted??performance.now());
          if(['text_delta','thinking_delta','toolcall_delta'].includes(e.assistantMessageEvent?.type)){rpc.deltaCount++;if(rpc.firstDelta===null)rpc.firstDelta=elapsedMs;rpc.lastDelta=elapsedMs;}
          const kind=e.assistantMessageEvent?.type;if(['thinking_start','thinking_delta'].includes(kind)&&rpc.thinkingStart===null)rpc.thinkingStart=performance.now();
          if(['thinking_end','text_start','text_delta','toolcall_start'].includes(kind)&&rpc.thinkingStart!==null){rpc.thinkingMs+=performance.now()-rpc.thinkingStart;rpc.thinkingStart=null;}
          e.timing={elapsedMs,firstDeltaMs:rpc.firstDelta,thinkingMs:rpc.thinkingMs+(rpc.thinkingStart!==null?performance.now()-rpc.thinkingStart:0),isThinking:rpc.thinkingStart!==null};
        }
        if(e.type==='message_end'&&e.message?.role==='assistant'){
          if(rpc.thinkingStart!==null){rpc.thinkingMs+=performance.now()-rpc.thinkingStart;rpc.thinkingStart=null;}
          e.replyMetrics=completedMetrics(e.message,performance.now()-(rpc.requestStarted??rpc.messageStarted??performance.now()),{timings:rpc.serverTimings,firstDeltaMs:rpc.firstDelta,lastDeltaMs:rpc.lastDelta,deltaCount:rpc.deltaCount,thinkingMs:rpc.thinkingMs});
          e.replyMetrics.outputLimit=rpc.boundConnection.maxTokens??'auto';
          const write=(metricWrites.get(chat.id)||Promise.resolve()).then(async()=>{const entries=await replyMetrics(chat.id);entries[e.message.timestamp]=e.replyMetrics;await fs.writeFile(path.join(metricsDir,chat.id+'.json'),JSON.stringify(entries));}).catch(()=>{});metricWrites.set(chat.id,write);
          audit({type:'reply_end',chatId:chat.id,stopReason:e.message.stopReason,...e.replyMetrics,firstDeltaMs:rpc.firstDelta,deltaCount:rpc.deltaCount});
        }
        if(e.type==='agent_start')rpc.busy=true;
        if(e.type==='agent_settled'){rpc.busy=false;finishTurn(chat.id,rpc);rpc.command('get_session_stats').then(s=>broadcast(chat.id,{type:'stats',data:s})).catch(()=>{});}
        if(e.type==='message_end'&&e.message?.role==='assistant'&&e.message.errorMessage&&e.message.stopReason!=='aborted')broadcast(chat.id,{type:'app_error',message:e.message.errorMessage});
        broadcast(chat.id,e);
      });
      rpc.on('closed',message=>{finishTurn(chat.id,rpc);if(runners.get(chat.id)===rpc){runners.delete(chat.id);broadcast(chat.id,{type:'engine_closed',message});}});
      await rpc.command('get_state');await rpc.command('prompt',{message:'/bolt-capabilities'});runners.set(chat.id,rpc);return rpc;
    })();starting.set(chat.id,promise);
    try{return await promise;}finally{starting.delete(chat.id);}
  }
  app.use((req,res,next)=>{
    if(req.headers.host && !/^127\.0\.0\.1:\d+$/.test(req.headers.host)) return res.status(403).end();
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)return res.status(403).end();
    res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Cross-Origin-Resource-Policy','same-origin');
    res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");next();
  });
  app.use('/api',(req,res,next)=>req.headers['x-bolt-token']===token?next():res.status(403).json({error:'Unauthorized'}));
  app.use(express.json({limit:'20mb'}));
  app.post('/internal/chats/:id/web',async(req,res)=>{
    const chat=meta.chats.find(item=>item.id===req.params.id);
    const rpc=runners.get(req.params.id);
    if(req.headers.origin||!native?.webTools||!chat?.webEnabled||!rpc?.busy||!rpc.webKey||req.headers['x-bolt-web-key']!==rpc.webKey){
      return res.status(403).json({error:'Web access is disabled for this chat.'});
    }
    if(rpc.webPending>=4)return res.status(429).json({error:'Wait for the other web requests to finish.'});
    const cancel=new AbortController();
    res.once('close',()=>cancel.abort());
    rpc.webPending++;
    try{
      const signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(15000)]);
      const kind=String(req.body.kind||'');
      const result=kind.startsWith('browser-')
        ?await (native.browser?native.browser.agent(kind,req.body.input||{},signal):Promise.reject(new Error('The JoltDesk browser is available in the desktop app.')))
        :await native.webTools(kind,req.body.input||{},signal);
      if(!res.destroyed)res.json(result);
    }finally{rpc.webPending--;}
  });
  app.get('/bootstrap.js',(_req,res)=>res.type('js').send(`window.BOLT_TOKEN=${JSON.stringify(token)};`));
  app.get('/api/config',(_req,res)=>res.json(config()));
  app.get('/api/connections/status',async(_req,res)=>{await Promise.all(meta.connections.map(checkEndpoint));res.json({statuses:Object.fromEntries(meta.connections.map(c=>[c.id,endpointStatuses.get(c.id)||{state:'saved'}]))});});
  app.post('/api/model',async(req,res)=>{if(!models.some(m=>m.id===req.body.modelId))throw new Error('Choose an available model.');meta.preferredModels={...meta.preferredModels,[credentialId(connection)]:req.body.modelId};await save();res.json({modelId:req.body.modelId});});
  app.get('/api/engine',(_req,res)=>res.json(engine?.status()||null));
  app.post('/api/engine/check',async(_req,res)=>{if(!engine)throw new Error('No bundled engine is available in this source checkout. Run npm run bundle:engine.');res.json(await engine.check());});
  app.post('/api/engine/automatic',async(req,res)=>{if(!engine)throw new Error('No bundled engine is available.');res.json(await engine.setAutomatic(req.body.enabled));});
  app.post('/api/engine/install',async(_req,res)=>{
    if(!engine)throw new Error('No bundled engine is available.');
    if(meta.binary)throw new Error('Select the bundled engine before installing managed updates.');
    if(starting.size||[...runners.values()].some(r=>r.busy))throw new Error('Finish or stop your active chats before updating.');
    const result=await engine.install();
    for(const rpc of runners.values())rpc.close();runners.clear();
    models=[];
    if(connected){try{const result=await connectionModels(connection,key);models=result.models;connectionNote=result.note;rememberProfile();await save();}catch(e){connectionError=e.message;}}
    for(const id of subscribers.keys())broadcast(id,{type:'engine_updated',engine:result,models});
    res.json(config());
  });
  app.post('/api/connect',async(req,res)=>{
    await changeConnection(async()=>{
    const target=req.body.provider==='local'?{provider:'local',baseUrl:normalizeBaseUrl(req.body.baseUrl),profile:req.body.profile==='generic'?'generic':'llamacpp',
      contextWindow:optionalInteger(req.body.contextWindow==='auto'?null:req.body.contextWindow,'Context window',256),maxTokens:req.body.maxTokens==='auto'||req.body.maxTokens==null||req.body.maxTokens===''?'auto':optionalInteger(req.body.maxTokens,'Max output tokens'),thinking:['on','off'].includes(req.body.thinking)?req.body.thinking:'auto',thinkingTokenBudget:optionalInteger(req.body.thinkingTokenBudget,'Thinking token budget',0),autoConnect:true}:{...OPENAI_CONNECTION};
    const existing=req.body.connectionId?meta.connections.find(c=>c.id===req.body.connectionId):meta.connections.find(c=>credentialId(c)===credentialId(target));
    if(req.body.connectionId&&!existing)throw new Error('Saved connection not found. Add it as a new API.');
    if(existing&&credentialId(existing)!==credentialId(target))throw new Error('Use Add API for a different URL so the saved endpoint is preserved.');
    target.id=existing?.id||randomUUID();target.revision=(existing?.revision||0)+1;target.name=String(req.body.name||existing?.name||connectionName(target)).trim();if(!target.name||target.name.length>80)throw new Error('Enter a connection name between 1 and 80 characters.');
    const supplied=typeof req.body.key==='string'?req.body.key.trim():'';
    const candidate=supplied||(req.body.forgetKey?'':sessionKeys[credentialId(target)]||'');
    const result=await connectionModels(target,candidate);
    if(!result.models.length)throw new Error('No compatible chat models found. Update Pi-Bolt and reconnect.');
    models=result.models;connectionNote=result.note;connectionError=null;key=candidate;connection=target;connected=true;rememberProfile();
    sessionKeys[credentialId(target)]=candidate;
    if(req.body.remember&&vault&&candidate){secrets[credentialId(target)]=candidate;await vault.set(JSON.stringify({version:2,keys:secrets}));}
    else if(req.body.forgetKey){delete secrets[credentialId(target)];await vault?.set(JSON.stringify({version:2,keys:secrets}));}
    await save();});
    res.json(config());
  });
  app.post('/api/connections/:id/activate',async(req,res)=>{const profile=meta.connections.find(c=>c.id===req.params.id);if(!profile)return res.status(404).json({error:'Connection not found'});await changeConnection(()=>activateConnection(profile));res.json(config());});
  app.post('/api/connections/:id/settings',async(req,res)=>{await changeConnection(async()=>{
    const profile=meta.connections.find(c=>c.id===req.params.id);if(!profile)throw new Error('Saved connection not found.');
    const baseUrl=profile.provider==='local'?normalizeBaseUrl(req.body.baseUrl||profile.baseUrl):profile.baseUrl;
    if(baseUrl!==profile.baseUrl||(req.body.provider&&req.body.provider!==profile.provider))throw new Error('Use Add API for a different endpoint so the saved API is preserved.');
    const name=String(req.body.name||profile.name).trim();if(!name||name.length>80)throw new Error('Enter a connection name between 1 and 80 characters.');
    const target={...profile,name,revision:(profile.revision||0)+1};delete target.models;
    if(profile.provider==='local'){target.profile=req.body.profile==='generic'?'generic':'llamacpp';target.contextWindow=optionalInteger(req.body.contextWindow==='auto'?null:req.body.contextWindow,'Context window',256);target.maxTokens=req.body.maxTokens==='auto'||req.body.maxTokens==null||req.body.maxTokens===''?'auto':optionalInteger(req.body.maxTokens,'Max output tokens');target.thinking=['on','off'].includes(req.body.thinking)?req.body.thinking:'auto';target.thinkingTokenBudget=optionalInteger(req.body.thinkingTokenBudget,'Thinking token budget',0);}
    const scope=credentialId(target),candidate=(typeof req.body.key==='string'?req.body.key.trim():'')||sessionKeys[scope]||'';
    const result=await connectionModels(target,candidate);if(!result.models.length)throw new Error('No compatible models found.');
    if(req.body.remember&&vault&&candidate){const next={...secrets,[scope]:candidate};await vault.set(JSON.stringify({version:2,keys:next}));secrets=next;}
    sessionKeys[scope]=candidate;Object.assign(profile,target,{models:result.models});endpointStatuses.set(profile.id,{state:'connected',checkedAt:Date.now()});
    if(connection.id===profile.id){connection=target;models=result.models;key=candidate;connectionNote=result.note;connectionError=null;connected=true;rememberProfile();}
    await save();
  });res.json(config());});
  app.patch('/api/connections/:id',async(req,res)=>{const profile=meta.connections.find(c=>c.id===req.params.id);if(!profile)return res.status(404).json({error:'Connection not found'});const name=String(req.body.name||'').trim();if(!name||name.length>80)throw new Error('Enter a connection name between 1 and 80 characters.');profile.name=name;if(connection.id===profile.id){connection.name=name;meta.connection=connection;}await save();res.json(config());});
  app.delete('/api/connections/:id',async(req,res)=>{const profile=meta.connections.find(c=>c.id===req.params.id);if(!profile)return res.status(404).json({error:'Connection not found'});await changeConnection(async()=>{
    if([...runners.values()].some(r=>r.boundConnection?.id===profile.id&&r.busy))throw new Error('This API has a running chat. Stop that reply before removing the API.');
    if([...starting.keys()].some(id=>meta.chats.find(c=>c.id===id)?.connectionId===profile.id))throw new Error('A chat is opening on this API. Try removing it again in a moment.');
    const scope=credentialId(profile);meta.connections=meta.connections.filter(c=>c.id!==profile.id);delete secrets[scope];delete sessionKeys[scope];endpointStatuses.delete(profile.id);
    for(const [id,rpc] of runners)if(rpc.boundConnection?.id===profile.id){rpc.close();runners.delete(id);}
    if(connection.id===profile.id){key='';models=[];connected=false;connection={...OPENAI_CONNECTION,autoConnect:false};meta.connection=connection;connectionError=null;}
    if(Object.keys(secrets).length)await vault?.set(JSON.stringify({version:2,keys:secrets}));else await vault?.clear();await save();});res.json(config());});
  app.post('/api/disconnect',async(_req,res)=>{await changeConnection(async()=>{const id=connection.id;if([...runners.values()].some(r=>r.boundConnection?.id===id&&r.busy))throw new Error('Stop this API’s running replies before disconnecting it.');if([...starting.keys()].some(chatId=>meta.chats.find(c=>c.id===chatId)?.connectionId===id))throw new Error('Wait for this API’s chat to finish opening.');for(const [chatId,rpc] of runners)if(rpc.boundConnection?.id===id){rpc.close();runners.delete(chatId);}key='';models=[];connected=false;connection={...connection,revision:(connection.revision||0)+1,autoConnect:false};meta.connection=connection;const profile=meta.connections.find(c=>c.id===id);if(profile){profile.revision=connection.revision;profile.autoConnect=false;}delete secrets[credentialId(connection)];delete sessionKeys[credentialId(connection)];endpointStatuses.delete(id);await save();if(Object.keys(secrets).length)await vault?.set(JSON.stringify({version:2,keys:secrets}));else await vault?.clear();});res.json(config());});
  app.post('/api/binary',async(req,res)=>{if(engine?.state.installing||starting.size||[...runners.values()].some(r=>r.busy))throw new Error('Wait until the engine is idle before changing it.');meta.binary=String(req.body.path||'');for(const rpc of runners.values())rpc.close();runners.clear();await save();res.json(config());});
  app.post('/api/pick-folder',async(_req,res)=>{if(!native)throw new Error('Folder picker is available in the desktop app. Enter a folder path in the browser.');res.json({path:await native.pickFolder()});});
  app.post('/api/projects',async(req,res)=>{
    const folder=path.resolve(req.body.path||path.join(dataDir,'workspace'));
    if(!(await fs.stat(folder)).isDirectory())throw new Error('Choose an existing project folder.');
    const project={id:randomUUID(),name:String(req.body.name||path.basename(folder)).slice(0,80),path:folder};
    meta.projects.push(project);await save();res.json(project);
  });
  app.post('/api/chats',async(req,res)=>{const preferred=req.body.model||meta.preferredModels?.[credentialId(connection)];const chat={id:randomUUID(),title:'New conversation',projectId:req.body.projectId||null,mode:'chat',webEnabled:!!native?.webTools&&req.body.webEnabled===true,connectionId:connection.id,model:models.find(m=>m.id===preferred)?.id||models[0]?.id,createdAt:Date.now()};meta.chats.unshift(chat);await save();res.json(chat);});
  app.patch('/api/chats/:id',async(req,res)=>{
    const chat=meta.chats.find(c=>c.id===req.params.id);if(!chat)return res.status(404).json({error:'Chat not found'});
    const rpc=starting.has(chat.id)?await starting.get(chat.id):runners.get(chat.id);if(rpc?.busy&&Object.keys(req.body).some(k=>!['mode','title'].includes(k)))throw new Error('Stop the active response before changing model or thinking settings.');
    if(req.body.title!==undefined){req.body.title=String(req.body.title).trim();if(!req.body.title||req.body.title.length>100)return res.status(400).json({error:'Enter a chat name between 1 and 100 characters.'});}
    if(req.body.mode&&!['chat','read','ask','bypass'].includes(req.body.mode))throw new Error('Invalid permission mode');
    if(req.body.mode&&rpc){
      const wasBusy=rpc.busy;await rpc.command('prompt',{message:`/bolt-permissions ${req.body.mode}${wasBusy?' continue':''}`});
      if(rpc.capabilities?.mode!==req.body.mode)throw new Error('The engine did not confirm the permission change.');
      if(rpc.pendingApproval){rpc.send({type:'extension_ui_response',id:rpc.pendingApproval,confirmed:req.body.mode==='bypass',cancelled:req.body.mode!=='bypass'});rpc.pendingApproval=null;broadcast(chat.id,{type:'approval_resolved'});}
      broadcast(chat.id,{type:'permission_changed',mode:req.body.mode,tools:rpc.capabilities.tools});
    }
    if(req.body.connectionId!==undefined&&!meta.connections.some(c=>c.id===req.body.connectionId))throw new Error('Select a saved API connection.');
    const targetModels=meta.connections.find(c=>c.id===(req.body.connectionId||chat.connectionId))?.models||models;
    if(req.body.model&&targetModels.length&&!targetModels.some(m=>m.id===req.body.model))throw new Error('Choose an available model from this API.');
    for(const k of ['title','model','mode','thinking','connectionId'])if(req.body[k]!==undefined)chat[k]=String(req.body[k]);
    if(req.body.webEnabled!==undefined)chat.webEnabled=!!native?.webTools&&req.body.webEnabled===true;
    await save();res.json(chat);
  });
  app.delete('/api/chats/:id',async(req,res)=>{
    const chat=meta.chats.find(c=>c.id===req.params.id);if(!chat)return res.status(404).json({error:'Chat not found'});
    if(starting.has(chat.id))return res.status(409).json({error:'This chat is still opening. Try deleting it again in a moment.'});
    if(runners.get(chat.id)?.busy)return res.status(409).json({error:'Stop this chat’s response before deleting it.'});
    // Keep a tombstone so recovery and older workspace copies cannot restore a deleted chat.
    meta.deletedChatIds=[...new Set([...(meta.deletedChatIds||[]),chat.id])];await save();
    const rpc=runners.get(chat.id);
    if(rpc&&!rpc.closed){const exited=new Promise(resolve=>rpc.child.once('exit',resolve));rpc.close();await exited;}
    runners.delete(chat.id);
    for(const socket of subscribers.get(chat.id)||[])socket.close();subscribers.delete(chat.id);
    // Archive files rather than permanently removing conversation contents.
    const trash=path.join(dataDir,'trash',chat.id);await fs.mkdir(trash,{recursive:true});
    for(const file of await fs.readdir(sessionDir))if(file.endsWith('_'+chat.id+'.jsonl'))await fs.rename(path.join(sessionDir,file),path.join(trash,file));
    await metricWrites.get(chat.id)?.catch(()=>{});
    await fs.rename(path.join(metricsDir,chat.id+'.json'),path.join(trash,'reply-metrics.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await checkpoints.remove(chat.id,trash);
    metricCache.delete(chat.id);res.json({deleted:true});
  });
  app.get('/api/chats/:id/history',async(req,res)=>{
    const chat=meta.chats.find(c=>c.id===req.params.id);if(!chat)return res.status(404).json({error:'Chat not found'});
    const rpc=await runner(chat);const [messages,stats,state]=await Promise.all([rpc.command('get_messages'),rpc.command('get_session_stats'),rpc.command('get_state')]);
    const metrics=await replyMetrics(chat.id),live=rpc.viewState?.streaming;
    res.json({messages:messages.messages,stats,state,busy:rpc.busy,sequence:rpc.eventSeq,live:live?{...live,elapsedMs:performance.now()-live.startedAt,firstDeltaMs:rpc.firstDelta,thinkingDurationMs:rpc.thinkingMs+(rpc.thinkingStart!==null?performance.now()-rpc.thinkingStart:0)}:null,approval:rpc.viewState?.approval,capabilities:rpc.capabilities,replyMetrics:metrics});
  });
  const checkpointChat=req=>{const chat=meta.chats.find(c=>c.id===req.params.id);if(!chat)throw new Error('Chat not found');return chat;};
  app.get('/api/chats/:id/checkpoints',async(req,res)=>{checkpointChat(req);res.json({turns:await checkpoints.list(req.params.id)});});
  app.get('/api/chats/:id/checkpoints/:turn/file',async(req,res)=>{checkpointChat(req);res.json(await checkpoints.file(req.params.id,req.params.turn,String(req.query.path||'')));});
  app.post('/api/chats/:id/checkpoints/:turn/restore',async(req,res)=>{
    const chat=checkpointChat(req);
    if(runners.get(chat.id)?.busy||starting.has(chat.id))throw new Error('Wait for the response to finish before undoing changes.');
    const result=await checkpoints.restore(chat.id,req.params.turn,{file:typeof req.body.path==='string'?req.body.path:undefined,force:req.body.force===true});
    if(result.restored.length){
      const previous=restoreNotes.get(chat.id);
      restoreNotes.set(chat.id,(previous?previous+' ':'')+'The user undid earlier agent edits and restored these files to their previous contents: '+result.restored.join(', ')+'. Read these files again before changing them.');
      broadcast(chat.id,{type:'checkpoints_changed'});
    }
    res.json(result);
  });
  // Git tab. Commits wait for the chat's agent so they never capture half-written files.
  const gitChat=req=>{const chat=meta.chats.find(c=>c.id===req.params.id);if(!chat)throw new Error('Chat not found');return chat;};
  app.get('/api/chats/:id/git',async(req,res)=>res.json(await gitOps.status(chatCwd(gitChat(req)))));
  app.get('/api/chats/:id/git/file',async(req,res)=>res.json(await gitOps.fileChange(chatCwd(gitChat(req)),String(req.query.path||''))));
  app.post('/api/chats/:id/git/commit',async(req,res)=>{
    const chat=gitChat(req);
    if(runners.get(chat.id)?.busy||starting.has(chat.id))throw new Error('Wait for the response to finish before committing.');
    res.json(await gitOps.commit(chatCwd(chat),{message:req.body.message,paths:req.body.paths}));
  });
  app.post('/api/chats/:id/git/push',async(req,res)=>res.json(await gitOps.push(chatCwd(gitChat(req)))));
  app.post('/api/chats/:id/git/message',async(req,res)=>{
    const chat=gitChat(req);
    const summary=await gitOps.changeSummary(chatCwd(chat),req.body.paths);
    const prompt=[
      'Write a Git commit message for these changes. Reply with only the message: a summary line in the imperative mood under 72 characters, then, only if useful, a blank line and a short body wrapped at 72 characters. No quotes, Markdown fences or commentary.',
      '','Branch: '+summary.branch,'Files:',...summary.files,'','Changes:',summary.diff
    ].join('\n');
    res.json({message:await oneShot(chat,prompt)});
  });
  // Runs one tool-free prompt on the chat's model in a separate engine process,
  // so nothing is added to the conversation.
  async function oneShot(chat,prompt){
    const rpc=await runner(chat);
    const model=rpc.models.find(m=>m.id===chat.model)||rpc.models[0];
    if(!model)throw new Error('Connect a model first.');
    const sessions=path.join(dataDir,'one-shot');await fs.mkdir(sessions,{recursive:true});
    const sessionId='one-shot-'+randomUUID();
    const temp=new Rpc({binary:selectedBinary(),cwd:chatCwd(chat),agentDir:path.join(dataDir,'runners',chat.id,'agent'),sessionDir:sessions,sessionId,key:rpc.keySnapshot,mode:'chat',autoOutput:rpc.boundConnection.provider==='local'&&rpc.boundConnection.maxTokens==='auto'});
    let timer;
    try{
      let failure=null;
      const settled=new Promise((resolve,reject)=>{
        temp.on('event',e=>{
          if(e.type==='message_end'&&e.message?.role==='assistant'&&e.message.errorMessage)failure=e.message.errorMessage;
          if(e.type==='agent_settled')resolve();
        });
        temp.on('closed',message=>reject(new Error(message)));
      });
      settled.catch(()=>{});
      await temp.command('get_state');
      await temp.command('set_model',{provider:model.provider,modelId:model.id});
      const levels=await temp.command('get_available_thinking_levels').catch(()=>({levels:[]}));
      const level=['off','minimal','low'].find(l=>levels.levels?.includes(l));
      if(level)await temp.command('set_thinking_level',{level}).catch(()=>{});
      await temp.command('prompt',{message:prompt});
      await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The model took too long to answer.')),180000);})]);
      if(failure)throw new Error(failure);
      const {messages}=await temp.command('get_messages');
      const reply=messages.findLast(m=>m.role==='assistant');
      const raw=Array.isArray(reply?.content)?reply.content.filter(c=>c.type==='text').map(c=>c.text).join(''):String(reply?.content||'');
      const text=raw.replace(/<think>[\s\S]*?<\/think>/g,'').trim().replace(/^```[\w-]*\n?/,'').replace(/\n?```$/,'').trim();
      if(!text)throw new Error('The model did not return a message.');
      return text;
    }finally{
      clearTimeout(timer);
      temp.close();
      for(const file of await fs.readdir(sessions).catch(()=>[]))if(file.includes(sessionId))await fs.rm(path.join(sessions,file),{force:true}).catch(()=>{});
    }
  }
  async function inspectorFiles(chat){
    const rpc=runners.get(chat.id);
    if(!rpc)return [];
    const {messages}=await rpc.command('get_messages');
    return collectInspector(messages,rpc.viewState?.inspector).files;
  }
  async function localFile(chat,file){
    if(typeof file!=='string'||!file||file.includes('\0'))return null;
    const cwd=meta.projects.find(project=>project.id===chat.projectId)?.path||path.join(dataDir,'workspace');
    const fullPath=path.resolve(cwd,file);
    const local=value=>process.platform!=='win32'||/^[a-z]:\\[^:]*$/i.test(value);
    if(!local(fullPath))return null;
    try{
      const target=await fs.realpath(fullPath);
      if(!local(target))return null;
      const stat=await fs.stat(target);
      return stat.isFile()?{fullPath,modifiedAt:stat.mtimeMs}:null;
    }catch{return null;}
  }
  app.get('/api/chats/:id/files',async(req,res)=>{
    const chat=meta.chats.find(item=>item.id===req.params.id);
    if(!chat)return res.status(404).json({error:'Chat not found'});
    const files=await inspectorFiles(chat);
    const entries=await Promise.all(files.map(async file=>{
      const info=file.status==='done'?await localFile(chat,file.path):null;
      return [file.path,info?.modifiedAt??null];
    }));
    res.json({modifiedAt:Object.fromEntries(entries)});
  });
  app.post('/api/chats/:id/file-action',async(req,res)=>{
    const chat=meta.chats.find(item=>item.id===req.params.id);
    if(!chat)return res.status(404).json({error:'Chat not found'});
    const {action,path:requested}=req.body;
    if(!['open','open-with','reveal'].includes(action)||!native?.fileAction)throw new Error('File actions are available in JoltDesk.');
    const files=await inspectorFiles(chat);
    if(!files.some(file=>file.path===requested&&file.status==='done'))throw new Error('This file is not available in this chat.');
    const file=await localFile(chat,requested);
    if(!file)throw new Error('This file could not be found.');
    await native.fileAction(action,file.fullPath);
    res.json({ok:true});
  });
  http.on('upgrade',(req,socket,head)=>{
    const u=new URL(req.url,'http://127.0.0.1');
    if(u.searchParams.get('token')!==token||!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')||(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',(ws,req)=>{
    const id=new URL(req.url,'http://127.0.0.1').searchParams.get('chat');const chat=meta.chats.find(c=>c.id===id);
    if(!chat){ws.close();return;}if(!subscribers.has(id))subscribers.set(id,new Set());subscribers.get(id).add(ws);
    ws.on('close',()=>subscribers.get(id)?.delete(ws));
    ws.on('message',async raw=>{try{
      const msg=JSON.parse(raw);const rpc=await runner(chat);
      if(msg.type==='prompt'){
        if(/^\s*\/bolt-(permissions|capabilities|web)\b/.test(msg.message||''))throw new Error('Use the chat controls to change tool permissions.');
        if(!rpc.models.length||(rpc.boundConnection.provider==='openai'&&!rpc.keySnapshot))throw new Error('Connect this chat’s model API in Settings first.');
        if(rpc.busy)throw new Error('A response is already running.');
        rpc.busy=true;
        try{
          const webEnabled=!!rpc.webKey&&chat.webEnabled===true;
          if(!!rpc.capabilities?.webEnabled!==webEnabled){
            await rpc.command('prompt',{message:webEnabled?'/bolt-web on':'/bolt-web off'});
            if(rpc.capabilities?.webEnabled!==webEnabled)throw new Error('The engine did not confirm the web setting.');
          }
          const model=rpc.models.find(m=>m.id===chat.model)||rpc.models[0];if(!model)throw new Error('Reconnect to load models.');
          await rpc.command('set_model',{provider:model.provider,modelId:model.id});
          const levels=await rpc.command('get_available_thinking_levels');
          await rpc.command('set_thinking_level',{level:levels.levels.includes(chat.thinking)?chat.thinking:levels.levels.includes('medium')?'medium':levels.levels[0]});
          const state=await rpc.command('get_state');broadcast(id,{type:'model_state',state,levels:levels.levels});
          let message=String(msg.message||'');const images=[];
          for(const f of msg.files||[]){
            if(!f.name||typeof f.data!=='string')throw new Error('Invalid attachment');
            if(f.data.length>14000000)throw new Error('Attachment is too large.');
            if(['image/png','image/jpeg','image/webp','image/gif'].includes(f.type)){
              if(!model.input?.includes('image'))throw new Error('This model does not support image attachments.');
              images.push({type:'image',data:f.data,mimeType:f.type});
            }else if(f.type?.startsWith('text/')||/\.(md|json|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|xml|yaml|yml|toml|csv|log|sql|sh|txt)$/i.test(f.name)){
              const text=Buffer.from(f.data,'base64').toString('utf8');if(text.includes('\0'))throw new Error('Binary files are not supported.');
              message+=`\n\n<attached_file name=${JSON.stringify(f.name)}>\n${text}\n</attached_file>`;
            }else throw new Error('MVP attachments support text, source code, and images. PDF/Office support is not implemented yet.');
          }
          const note=restoreNotes.get(id);
          if(note){await rpc.command('prompt',{message:'/bolt-note '+note});restoreNotes.delete(id);}
          rpc.turn=await checkpoints.begin(id,{prompt:msg.message,cwd:chatCwd(chat)});
          const accepted=await rpc.command('prompt',{message,images});
          if(accepted?.disposition==='handled'){rpc.busy=false;finishTurn(id,rpc);broadcast(id,{type:'agent_settled'});}
          if(chat.title==='New conversation'){chat.title=String(msg.message||'Attached files').slice(0,55);await save();broadcast(id,{type:'chat_updated',chat});}
        }catch(e){rpc.busy=false;finishTurn(id,rpc);throw e;}
      }else if(msg.type==='abort'){await rpc.command('clear_queue');await rpc.command('abort',{},60000);}
      else if(msg.type==='ui_response'){rpc.send({type:'extension_ui_response',id:msg.id,confirmed:msg.confirmed,value:msg.value,cancelled:msg.cancelled});rpc.pendingApproval=null;broadcast(id,{type:'approval_resolved'});}
      else if(msg.type==='levels'){
        if(rpc.busy)return;
        const selected=rpc.models.find(m=>m.id===chat.model);if(selected)await rpc.command('set_model',{provider:selected.provider,modelId:chat.model});
        const levels=await rpc.command('get_available_thinking_levels');ws.send(JSON.stringify({type:'model_state',levels:levels.levels,state:await rpc.command('get_state')}));
      }else if(msg.type==='compact'){if(rpc.busy)throw new Error('Wait for the response to finish.');await rpc.command('compact',{},120000);ws.send(JSON.stringify({type:'stats',data:await rpc.command('get_session_stats')}));}
    }catch(e){ws.send(JSON.stringify({type:'app_error',message:e.message}));}});
  });
  app.use('/vendor',express.static(path.join(root,'node_modules')));
  app.use(express.static(path.join(root,'public')));
  app.use((error,_req,res,_next)=>res.status(400).json({error:error.message}));
  await new Promise(resolve=>http.listen(port,'127.0.0.1',resolve));
  const address=`http://127.0.0.1:${http.address().port}`;
  if(connection.autoConnect!==false&&(key||connection.provider==='local')){try{const result=await connectionModels(connection,key);models=result.models;connectionNote=result.note;connected=models.length>0;rememberProfile();await save();}catch(e){connectionError=e.message;}}
  if(autoStartUpdates)engine?.start();
  return {url:address,token,close:()=>{engine?.close();for(const rpc of runners.values())rpc.close();for(const ws of wss.clients)ws.close();http.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=await startServer({port:Number(process.env.PORT)||4317,dataDir:process.env.BOLT_DATA_DIR});console.log(`JoltDesk is ready: ${server.url}`);
  process.on('SIGINT',()=>{server.close();process.exit();});
}
