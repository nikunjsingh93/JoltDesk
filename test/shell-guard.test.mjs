import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startServer} from '../server.mjs';
import {mockProvider,testModel} from './mock-provider.mjs';
import {searchesWholeDisk} from '../approval.ts';

test('recognizes searches that start at the filesystem or a drive root',()=>{
  const cases={
    bash:[
      ['find / -name "a.html"','ls ~/Downloads | head; find / -name a -not -path "*/node_modules/*" 2>/dev/null | head','find /c -name x','find "C:/" -iname x','sudo find -L / -name x','cd x && find /c/ -type f'],
      ['find . -name x','find ~/Downloads -name x','find /c/Users/me -name x','find / -maxdepth 2 -name x','grep -r "find /" .','echo find /','ls /']
    ],
    powershell:[
      [String.raw`Get-ChildItem C:\ -Recurse -Filter a.html`,'gci -Recurse -Path C:\\','ls "D:/" -r'],
      [String.raw`Get-ChildItem C:\Users\me -Recurse`,'Get-ChildItem C:\\','gci . -Recurse']
    ]
  };
  for(const [tool,[blocked,permitted]] of Object.entries(cases)){
    for(const command of blocked)assert.equal(searchesWholeDisk(tool,command),true,command);
    for(const command of permitted)assert.equal(searchesWholeDisk(tool,command),false,command);
  }
});

test('real Pi-Bolt: whole-disk searches are blocked and shell commands get a default time limit',async()=>{
  const dir=path.resolve('work/shell-guard-'+Date.now()),provider=await mockProvider();
  await fs.mkdir(path.join(dir,'agent'),{recursive:true});
  await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'?Promise.resolve(new Response(JSON.stringify({data:[{id:'bolt-test'}]}),{headers:{'Content-Type':'application/json'}})):originalFetch(url,options);
  process.env.BOLT_SHELL_TIMEOUT='2';
  let server,ws;
  try{
    server=await startServer({dataDir:dir,autoStartUpdates:false});
    const api=async(route,body,method=body?'POST':'GET')=>{const r=await originalFetch(server.url+'/api'+route,{method,headers:{'Content-Type':'application/json','X-Bolt-Token':server.token},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
    await api('/connect',{key:'sk-test-not-real',remember:false});
    const chat=await api('/chats',{});await api('/chats/'+chat.id,{model:'bolt-test',mode:'bypass'},'PATCH');
    const events=[];ws=new WebSocket(server.url.replace('http','ws')+`/stream?chat=${chat.id}&token=${server.token}`);ws.on('message',d=>events.push(JSON.parse(d)));
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
    const run=async command=>{
      events.length=0;provider.tool('bash',{command});ws.send(JSON.stringify({type:'prompt',message:'Run it'}));
      const until=Date.now()+25000;
      while(!events.some(e=>e.type==='agent_settled')){
        const error=events.find(e=>e.type==='app_error');if(error)throw new Error(error.message);
        if(Date.now()>until)throw new Error('Timed out: '+command);
        await new Promise(r=>setTimeout(r,30));
      }
      const end=events.find(e=>e.type==='tool_execution_end');
      return {failed:end.isError,text:end.result.content.map(c=>c.text||'').join('')};
    };
    const blocked=await run('touch ran.txt; find / -name "page.html" 2>/dev/null | head');
    assert.ok(blocked.failed);assert.match(blocked.text,/searches the whole disk/);
    await assert.rejects(fs.stat(path.join(dir,'workspace','ran.txt')));
    const started=Date.now(),slow=await run('sleep 20');
    assert.ok(slow.failed);assert.match(slow.text,/timed out/i);assert.ok(Date.now()-started<15000);
    const normal=await run('echo still-works');
    assert.ok(!normal.failed);assert.match(normal.text,/still-works/);
  }finally{delete process.env.BOLT_SHELL_TIMEOUT;ws?.close();server?.close();provider.close();globalThis.fetch=originalFetch;}
});
