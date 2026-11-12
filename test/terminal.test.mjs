import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTerminals } from '../terminal.mjs';
import { cleanOutput } from '../public/terminal-panel.mjs';

const windows=process.platform==='win32';
function harness(){
  const events=[];
  const terminals=createTerminals({emit:(chatId,event)=>events.push({chatId,...event})});
  const ended=id=>new Promise((resolve,reject)=>{
    const started=Date.now();
    const check=()=>{const end=events.find(e=>e.op==='end'&&e.entry.id===id);if(end)return resolve(end.entry);if(Date.now()-started>20000)return reject(new Error('Command did not finish.'));setTimeout(check,25);};
    check();
  });
  return {events,terminals,ended};
}
async function folder(){
  const dir=path.resolve('work','terminal-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  await fs.mkdir(path.join(dir,'sub dir'),{recursive:true});
  return dir;
}

test('runs commands in the chat folder, streams output and handles cd',async()=>{
  const {terminals,events,ended}=harness(),dir=await folder();
  const first=await terminals.run('c1',dir,windows?'Write-Output hello; (Get-Location).Path':'echo hello; pwd');
  const done=await ended(first.id);
  assert.equal(done.status,'done');assert.equal(done.exitCode,0);
  assert.match(done.output,/hello/);
  assert.ok(done.output.includes(dir));
  assert.ok(events.some(e=>e.op==='output'&&e.id===first.id));

  const cd=await terminals.run('c1',dir,'cd "sub dir"');
  assert.equal((await ended(cd.id)).status,'done');
  assert.equal(terminals.state('c1',dir).cwd,path.join(dir,'sub dir'));
  const missing=await terminals.run('c1',dir,'cd nowhere');
  assert.equal((await ended(missing.id)).status,'failed');
  await ended((await terminals.run('c1',dir,'cd')).id);
  assert.equal(terminals.state('c1',dir).cwd,dir);

  const failing=await terminals.run('c1',dir,windows?'exit 3':'exit 3');
  const result=await ended(failing.id);
  assert.equal(result.status,'failed');assert.equal(result.exitCode,3);
  terminals.clear('c1');
  assert.deepEqual(terminals.state('c1',dir).entries,[]);
  await assert.rejects(terminals.run('c1',dir,'   '),/Type a command/);
});

test('sends input and stops long-running commands',async()=>{
  const {terminals,ended}=harness(),dir=await folder();
  const reader=await terminals.run('c2',dir,windows?'$line=[Console]::In.ReadLine(); Write-Output "got $line"':'read line; echo "got $line"');
  await new Promise(r=>setTimeout(r,windows?1500:200));
  terminals.input('c2',reader.id,'abc');
  assert.match((await ended(reader.id)).output,/got abc/);

  const slow=await terminals.run('c2',dir,windows?'Write-Output started; Start-Sleep -Seconds 60':'echo started; sleep 60');
  await new Promise(r=>setTimeout(r,1200));
  const began=Date.now();
  terminals.stop('c2',slow.id);
  const stopped=await ended(slow.id);
  assert.equal(stopped.status,'stopped');
  assert.ok(Date.now()-began<10000);
  assert.throws(()=>terminals.stop('c2',slow.id),/no longer running/);
});

test('mirrors agent commands from engine events',()=>{
  const {terminals,events}=harness();
  terminals.agentStart('c3','C:/project',{id:'call-1',tool:'powershell',command:'npm test'});
  terminals.agentOutput('c3','call-1','line 1\n');
  terminals.agentOutput('c3','call-1','line 1\nline 2\n');
  terminals.agentEnd('c3','call-1',{text:'line 1\nline 2\n',exitCode:0,isError:false});
  const [entry]=terminals.state('c3','C:/project').entries;
  assert.deepEqual({source:entry.source,status:entry.status,output:entry.output,command:entry.command},{source:'agent',status:'done',output:'line 1\nline 2\n',command:'npm test'});
  terminals.agentStart('c3','C:/project',{id:'call-2',tool:'bash',command:'sleep 100'});
  terminals.agentSettled('c3');
  assert.equal(terminals.state('c3','C:/project').entries[1].status,'stopped');
  assert.ok(events.some(e=>e.op==='start'&&e.entry.id==='call-2'));
});

test('cleans color codes and progress redraws',()=>{
  assert.equal(cleanOutput('\x1b[32mgreen\x1b[0m\r\n'),'green\n');
  assert.equal(cleanOutput('10%\r50%\r100%\ndone'),'100%\ndone');
});
