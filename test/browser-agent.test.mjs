import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readableArguments } from '../public/stream-content.mjs';

const {resolveAgentUrl}=createRequire(import.meta.url)('../browser-agent.cjs');
const publicOnly=async url=>{if(/192\.168\./.test(url))throw new Error('This address is outside the public web.');return url;};

test('agent addresses: public pages, local dev servers, and files with permission',async()=>{
  const file=path.resolve('work','agent-url-'+Date.now()+'.html');
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'<title>x</title>');
  const resolve=(url,allowFiles=true)=>resolveAgentUrl(url,{allowFiles,checkPublic:publicOnly});
  assert.equal(await resolve('https://example.com/a'),'https://example.com/a');
  assert.equal(await resolve('http://localhost:5173/'),'http://localhost:5173/');
  assert.equal(await resolve('http://127.0.0.1:8080/app'),'http://127.0.0.1:8080/app');
  assert.equal(await resolve(file),pathToFileURL(file).href);
  assert.equal(await resolve(pathToFileURL(file).href),pathToFileURL(file).href);
  await assert.rejects(resolve(file,false),/Read files permission/);
  await assert.rejects(resolve(file+'.missing'),/does not exist/);
  await assert.rejects(resolve('http://192.168.1.1/'),/public web/);
  await assert.rejects(resolve('ftp://example.com'),/web pages and local files/);
  await assert.rejects(resolve('\\\\server\\share\\a.html'),/Network file shares/);
  await assert.rejects(resolve('not a url'),/full URL/);
});

test('streaming tool arguments read as decoded, indented text',()=>{
  const json=JSON.stringify({path:'src/app.js',edits:[{oldText:'const a = 1;\nconst b = 2;',newText:'const a = 3;'},{oldText:'x',newText:'y'}],count:2,flag:true});
  assert.equal(readableArguments(json),[
    'path: src/app.js','edits:','  - oldText: |','      const a = 1;','      const b = 2;','    newText: const a = 3;','  - oldText: x','    newText: y','count: 2','flag: true'
  ].join('\n'));
  // A cut-off stream shows what has arrived so far, with real line breaks.
  assert.equal(readableArguments(json.slice(0,58)),'path: src/app.js\nedits:\n  - oldText: |\n      const a = 1;\n      co');
  assert.equal(readableArguments('{"command":"npm test"}'),'command: npm test');
  assert.equal(readableArguments(''),'');
});
