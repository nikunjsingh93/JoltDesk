import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,existsSync,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {EngineManager,assetFor,isNewer,verifyChecksums,checksumFor,validateRelease,removeOwned} from '../engine-updater.mjs';
import {Rpc} from '../rpc.mjs';

test('release verification rejects tampering, unexpected sources and unsafe owned paths',async()=>{
  assert.equal(assetFor('win32','arm64'),'pi-bolt-win32-x64.zip');assert.equal(assetFor('linux','x64'),'pi-bolt-linux-x64-baseline.tar.gz');
  assert.throws(()=>assetFor('darwin','x64'),/No supported/);assert.equal(isNewer('bolt-v1.10.0','bolt-v1.9.0'),true);assert.equal(isNewer('bolt-v1.1.4','bolt-v1.1.4'),false);
  const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const sums=Buffer.from('a'.repeat(64)+'  engine.zip\n'),signature=sign(null,sums,keys.privateKey);
  verifyChecksums(sums,signature,publicKey);assert.throws(()=>verifyChecksums(Buffer.from('tampered'),signature,publicKey),/signature verification failed/);
  assert.equal(checksumFor(sums,'engine.zip'),'a'.repeat(64));assert.throws(()=>checksumFor(sums,'absent.zip'),/Missing signed checksum/);
  assert.throws(()=>validateRelease({tag_name:'bolt-v1.1.4',assets:[{name:'engine.zip',browser_download_url:'https://untrusted.example/engine.zip'}]},'engine.zip'),/Unexpected/);
  const parent=path.resolve('work/owned-staging');await assert.rejects(removeOwned(parent,parent),/Refusing/);await assert.rejects(removeOwned(path.join(parent,'..','unrelated'),parent),/Refusing/);
});

const fixtures=path.resolve('work/update-fixtures');
test('signed real release: failed updates preserve current engine; successful activation survives offline restart', {skip:process.platform!=='win32'||!existsSync(path.join(fixtures,'pi-bolt-win32-x64.zip'))},async()=>{
  const dir=path.resolve('work/update-test-'+Date.now()),bundle=path.join(dir,'bundled');await fs.mkdir(bundle,{recursive:true});
  await fs.writeFile(path.join(bundle,'pi-bolt.exe'),'old-engine-test-fixture');
  await fs.writeFile(path.join(bundle,'bundle-meta.json'),JSON.stringify({tag:'bolt-v1.1.3',platform:'win32'}));
  const release=JSON.parse(await fs.readFile('work/latest-release.json','utf8'));let corruptSignature=false,corruptArchive=false,compatibilityFailure=false,downloads=0;
  const fetcher=async url=>{
    if(String(url).includes('/releases/latest'))return new Response(JSON.stringify(release));
    const name=new URL(url).pathname.split('/').at(-1);
    if(name==='SHA256SUMS.sig'&&corruptSignature)return new Response(Buffer.alloc(64));
    if(name.endsWith('.zip')){downloads++;if(corruptArchive)return new Response('corrupted download');}
    assert.ok(['SHA256SUMS','SHA256SUMS.sig','pi-bolt-win32-x64.zip'].includes(name),'Unexpected download');
    return new Response(Readable.toWeb(createReadStream(path.join(fixtures,name))));
  };
  const verifyEngine=async binary=>{
    if(compatibilityFailure)throw new Error('simulated incompatible RPC');
    assert.ok(binary.includes('stage-'));
    const agentDir=path.join(dir,'health');await fs.mkdir(agentDir,{recursive:true});
    const rpc=new Rpc({binary,cwd:agentDir,agentDir,sessionDir:agentDir,sessionId:'health'});
    try{assert.ok((await rpc.command('get_state')).sessionId);}finally{if(!rpc.closed)await new Promise(r=>{rpc.child.once('close',r);rpc.close();});}
  };
  const manager=await new EngineManager({bundledDir:bundle,dataDir:dir,platform:'win32',arch:'arm64',fetcher,verifyEngine}).init();
  const original=manager.binary();await manager.check();assert.equal(manager.status().available,true);
  corruptSignature=true;await assert.rejects(manager.install(),/signature verification failed/);assert.equal(manager.binary(),original);assert.equal(downloads,0);
  corruptSignature=false;corruptArchive=true;await assert.rejects(manager.install(),/checksum mismatch/);assert.equal(manager.binary(),original);
  corruptArchive=false;compatibilityFailure=true;await assert.rejects(manager.install(),/incompatible RPC/);assert.equal(manager.binary(),original);
  compatibilityFailure=false;const updated=await manager.install();assert.equal(updated.current,release.tag_name);assert.equal(updated.source,'managed update');assert.notEqual(manager.binary(),original);
  await manager.setAutomatic(false);
  const offline=await new EngineManager({bundledDir:bundle,dataDir:dir,platform:'win32',arch:'arm64',fetcher:async()=>{throw new Error('offline');},verifyEngine}).init();
  assert.equal(offline.binary(),manager.binary());assert.equal(offline.status().automatic,false);
  await offline.check();assert.equal(offline.status().current,release.tag_name);assert.match(offline.status().error,/offline/);
  // A broken managed binary falls back to the engine shipped in the app.
  await fs.writeFile(offline.binary(),'corrupted managed executable');
  const fallback=await new EngineManager({bundledDir:bundle,dataDir:dir,platform:'win32',arch:'arm64',fetcher,verifyEngine}).init();assert.equal(fallback.binary(),original);
  manager.close();offline.close();fallback.close();
});
