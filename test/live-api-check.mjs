import { discoverLocal } from '../connections.mjs';

const baseUrl=process.env.BOLT_TEST_BASE_URL;
if(!baseUrl){
  console.error('Set BOLT_TEST_BASE_URL to the model server you want to check.');
  process.exit(2);
}

const profile=process.env.BOLT_TEST_PROFILE==='generic'?'generic':'llamacpp';
try{
  const result=await discoverLocal({baseUrl,profile},process.env.BOLT_TEST_API_KEY||'');
  const models=result.definition.models.map(model=>({
    id:model.id,
    contextWindow:model.contextWindow,
    estimatedContext:result.estimates[model.id],
    thinkingLevels:Object.keys(model.thinkingLevelMap||{}).filter(level=>model.thinkingLevelMap[level]!==null),
    inputs:model.input,
  }));
  console.log(JSON.stringify({models,note:result.note},null,2));
}catch(error){
  console.error(error.message);
  process.exitCode=1;
}
