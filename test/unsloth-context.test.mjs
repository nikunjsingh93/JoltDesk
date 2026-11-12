import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLocal, studioContextFor } from '../connections.mjs';

// Simulates an authenticated Unsloth Studio server with two listed models, one loaded.
function studio({loaded='ornith-ai/Ornith-1.5-35B-A3B-GGUF',context=131072}={}){
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push(url);
    if(options?.headers?.Authorization!=='Bearer studio-key')return new Response('{"detail":"Not authenticated"}',{status:401});
    const path=new URL(url).pathname;
    if(path==='/v1/models')return Response.json({data:[
      {id:'ornith-ai/Ornith-1.5-35B-A3B-GGUF',owned_by:'unsloth-studio'},
      {id:'unsloth/Qwen3.8-27B-GGUF',owned_by:'unsloth-studio'}
    ]});
    if(path==='/v1/status')return Response.json({model_identifier:loaded,active_model:loaded,context_length:context,native_context_length:262144});
    return Response.json({detail:'API endpoint not found'},{status:404});
  };
  return {fetcher,calls};
}

test('uses the loaded Unsloth Studio model’s runtime context',async()=>{
  const {fetcher,calls}=studio();
  const result=await discoverLocal({baseUrl:'http://127.0.0.1:8888/v1',profile:'llamacpp',maxTokens:'auto'},'studio-key',fetcher);
  const ornith=result.definition.models.find(m=>m.id==='ornith-ai/Ornith-1.5-35B-A3B-GGUF');
  const qwen=result.definition.models.find(m=>m.id==='unsloth/Qwen3.8-27B-GGUF');
  assert.equal(ornith.contextWindow,131072);
  assert.equal(ornith.maxTokens,131072);
  assert.equal(result.estimates[ornith.id],false);
  // A model that is not loaded keeps an internal fallback but is marked as an estimate.
  assert.equal(result.estimates[qwen.id],true);
  assert.deepEqual(result.studioModels.sort(),[ornith.id,qwen.id].sort());
  assert.ok(calls.some(url=>url.endsWith('/v1/status')));
});

test('never applies the status of a different loaded model',()=>{
  const status={model_identifier:'unsloth/Qwen3.8-27B-GGUF',active_model:'unsloth/Qwen3.8-27B-GGUF',context_length:65536};
  assert.equal(studioContextFor(status,{id:'ornith-ai/Ornith-1.5-35B-A3B-GGUF'}),null);
  assert.equal(studioContextFor(status,{id:'unsloth/Qwen3.8-27B-GGUF'}),65536);
  assert.equal(studioContextFor({model_identifier:'x',context_length:null},{id:'x'}),null);
  assert.equal(studioContextFor(null,{id:'x'}),null);
});

test('detects image support for Unsloth Studio models',async()=>{
  const fetcher=async(url,options)=>{
    if(options?.headers?.Authorization!=='Bearer studio-key')return new Response('{}',{status:401});
    const path=decodeURIComponent(new URL(url).pathname);
    if(path==='/v1/models')return Response.json({data:[
      {id:'ornith-ai/Ornith-1.5-35B-A3B-GGUF',owned_by:'unsloth-studio'},
      {id:'unsloth/Gemma-4-12B-GGUF',owned_by:'unsloth-studio'},
      {id:'unsloth/Qwen3-VL-8B-Instruct-GGUF',owned_by:'unsloth-studio'},
      {id:'unsloth/Qwen3.8-27B-GGUF',owned_by:'unsloth-studio'}
    ]});
    if(path==='/v1/status')return Response.json({model_identifier:'ornith-ai/Ornith-1.5-35B-A3B-GGUF',context_length:131072,is_vision:true});
    if(path==='/api/models/check-vision/unsloth/Gemma-4-12B-GGUF')return Response.json({model_name:'unsloth/Gemma-4-12B-GGUF',is_vision:true});
    if(path==='/api/models/check-vision/unsloth/Qwen3.8-27B-GGUF')return Response.json({model_name:'unsloth/Qwen3.8-27B-GGUF',is_vision:false});
    return Response.json({detail:'API endpoint not found'},{status:404});
  };
  const result=await discoverLocal({baseUrl:'http://127.0.0.1:8888/v1',profile:'llamacpp',maxTokens:'auto'},'studio-key',fetcher);
  const input=Object.fromEntries(result.definition.models.map(m=>[m.id,m.input.includes('image')]));
  assert.deepEqual(input,{
    'ornith-ai/Ornith-1.5-35B-A3B-GGUF':true,   // loaded, from /v1/status
    'unsloth/Gemma-4-12B-GGUF':true,            // from the vision check
    'unsloth/Qwen3-VL-8B-Instruct-GGUF':true,   // no answer, but a VL model
    'unsloth/Qwen3.8-27B-GGUF':false
  });
});
