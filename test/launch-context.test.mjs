import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchContext} from '../connections.mjs';

test('llama.cpp router: launch --ctx-size beats the trained context length',()=>{
  const unloaded={id:'ornith',context_length:262144,status:{value:'unloaded',args:['llama-server.exe','--ctx-size','131072','--jinja']}};
  assert.equal(launchContext(unloaded),131072);
  assert.equal(launchContext({status:{args:['-c','32768']}}),32768);
  assert.equal(launchContext({status:{args:['--ctx-size','0']}}),null);
  assert.equal(launchContext({context_length:262144}),null);
});
