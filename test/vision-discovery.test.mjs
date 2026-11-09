import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverLocal} from '../connections.mjs';

test('Splash advertises image input separately from llama.cpp props',async()=>{
  for(const metadata of [{vision:true},{input_modalities:['text','image']},{vision:false,input_modalities:['text']}]){
    const fetcher=async url=>new Response(JSON.stringify(String(url).endsWith('/models')?{data:[{id:'qwen-local',...metadata}]}:{}));
    const result=await discoverLocal({baseUrl:'https://model.example/v1',profile:'llamacpp'},'',fetcher);
    assert.deepEqual(result.definition.models[0].input,metadata.vision===true||metadata.input_modalities?.includes('image')?['text','image']:['text']);
  }
});
