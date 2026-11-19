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

import {torcContextFromCommandLine,torcLaunchContext} from '../connections.mjs';
test('ToRc: context is the fourth argument of torc-server',()=>{
  const cmd='"C:\\Apps\\ToRc\\engine\\torc-server.exe" "C:\\Apps\\ToRc\\models\\Qwen 3.6.torc" 8081 auto 131072 qwen3.6-35b-torc';
  assert.equal(torcContextFromCommandLine(cmd),131072);
  assert.equal(torcContextFromCommandLine('torc-server model.torc 8080 auto'),null);
  assert.equal(torcContextFromCommandLine('node server.js 8081 auto 4096'),null);
  assert.equal(torcContextFromCommandLine(''),null);
});
test('ToRc: only local servers are inspected',async()=>{
  let ran=false;const run=async()=>{ran=true;return '';};
  assert.equal(await torcLaunchContext('http://192.168.1.5:8081/v1',run),null);
  assert.equal(ran,false);
});

import {torcVisionFromSettings} from '../connections.mjs';
test('ToRc: image support follows the TORC_MMPROJ switch in /torc/settings',()=>{
  assert.equal(torcVisionFromSettings({switches:{TORC_NPU:'1',TORC_MMPROJ:'<path>'}}),true);
  assert.equal(torcVisionFromSettings({switches:{TORC_NPU:'1'}}),false);
  assert.equal(torcVisionFromSettings({switches:{TORC_MMPROJ:''}}),false);
  assert.equal(torcVisionFromSettings(null),false);
});
