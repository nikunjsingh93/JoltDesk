import { promises as fs, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import * as tar from 'tar';

const API='https://api.github.com/repos/opensec-git/Pi-Bolt/releases/latest';
// Pinned upstream Ed25519 release key, also published in Pi-Bolt's official installer.
const RELEASE_KEY='MCowBQYDK2VwAyEAoLboJqtKaoISPqffk03vHZr+1sRBG3uIRIWeKOew+aY=';
const TAG=/^bolt-v(\d+)\.(\d+)\.(\d+)$/;
export function isNewer(a,b){
  const av=TAG.exec(a),bv=TAG.exec(b);if(!av||!bv)return false;
  for(let i=1;i<=3;i++){if(+av[i]!==+bv[i])return +av[i]>+bv[i];}return false;
}
export function assetFor(platform=process.platform,arch=process.arch){
  if(platform==='win32'&&['x64','arm64'].includes(arch))return 'pi-bolt-win32-x64.zip';
  if(platform==='darwin'&&arch==='arm64')return 'pi-bolt-darwin-arm64.tar.gz';
  if(platform==='linux'&&arch==='x64')return 'pi-bolt-linux-x64-baseline.tar.gz';
  if(platform==='linux'&&arch==='arm64')return 'pi-bolt-linux-arm64.tar.gz';
  throw new Error(`No supported Pi-Bolt release for ${platform}/${arch}.`);
}
export function validateRelease(release,assetName){
  if(!TAG.test(release.tag_name)||release.prerelease||release.draft)throw new Error('Expected an official stable Pi-Bolt release.');
  for(const name of [assetName,'SHA256SUMS','SHA256SUMS.sig']){
    const asset=release.assets?.find(a=>a.name===name);if(!asset)throw new Error(`Release is missing ${name}.`);
    const u=new URL(asset.browser_download_url);
    if(u.protocol!=='https:'||u.hostname!=='github.com'||u.pathname!==`/opensec-git/Pi-Bolt/releases/download/${release.tag_name}/${name}`)throw new Error('Unexpected release download location.');
  }return release;
}
export function verifyChecksums(sums,signature,key=RELEASE_KEY){
  const publicKey=createPublicKey({key:Buffer.from(key,'base64'),format:'der',type:'spki'});
  if(!verify(null,sums,publicKey,signature))throw new Error('Pi-Bolt release signature verification failed. The current engine was kept.');
}
export function checksumFor(sums,name){
  const line=sums.toString('utf8').split(/\r?\n/).find(l=>l.slice(64).trim().replace(/^\*/,'')===name);
  if(!line||!/^[a-f0-9]{64}\s/i.test(line))throw new Error(`Missing signed checksum for ${name}.`);
  return line.slice(0,64).toLowerCase();
}
export async function hashFile(file){const h=createHash('sha256');for await(const c of createReadStream(file))h.update(c);return h.digest('hex');}
export async function removeOwned(target,parent){
  const absolute=path.resolve(target),relative=path.relative(path.resolve(parent),absolute);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Refusing to remove a path outside engine staging.');
  await fs.rm(absolute,{recursive:true,force:true,maxRetries:12,retryDelay:200});
}
async function renameReady(from,to){
  for(let attempt=0;;attempt++)try{return await fs.rename(from,to);}catch(e){
    if(attempt>=12||!['EPERM','EBUSY','EACCES'].includes(e.code))throw e;
    await new Promise(resolve=>setTimeout(resolve,200+attempt*100));
  }
}
async function response(url,fetcher,timeout=20000){
  const r=await fetcher(url,{headers:{'User-Agent':'JoltDesk/0.10.9','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw new Error(r.status===403||r.status===429?'Update service rate limit reached. Try again later.':`Update request failed (${r.status}).`);
  return r;
}
export async function getLatest(fetcher=fetch){return (await response(API,fetcher)).json();}
async function smallAsset(url,fetcher){const r=await response(url,fetcher);const data=Buffer.from(await r.arrayBuffer());if(data.length>1024*1024)throw new Error('Release verification file is too large.');return data;}
async function findExecutable(dir,platform){
  const name=platform==='win32'?'pi-bolt.exe':'pi';
  if(existsSync(path.join(dir,name)))return dir;
  const entries=await fs.readdir(dir,{withFileTypes:true});
  for(const e of entries)if(e.isDirectory()&&existsSync(path.join(dir,e.name,name)))return path.join(dir,e.name);
  throw new Error('The downloaded release has no Pi-Bolt executable.');
}
export function binaryIn(dir,platform=process.platform){return path.join(dir,platform==='win32'?'pi-bolt.exe':'pi');}

export async function stageRelease({release,assetName,parent,platform=process.platform,fetcher=fetch,onProgress=()=>{}}){
  validateRelease(release,assetName);await fs.mkdir(parent,{recursive:true});
  const stage=path.join(parent,'stage-'+randomUUID());await fs.mkdir(stage);
  try{
    const asset=name=>release.assets.find(a=>a.name===name);
    onProgress({phase:'verifying',message:'Verifying signed release checksums…'});
    const [sums,signature]=await Promise.all([smallAsset(asset('SHA256SUMS').browser_download_url,fetcher),smallAsset(asset('SHA256SUMS.sig').browser_download_url,fetcher)]);
    verifyChecksums(sums,signature);const expected=checksumFor(sums,assetName),a=asset(assetName);
    if(a.size>600*1024*1024)throw new Error('Engine archive exceeds the download limit.');
    const archive=path.join(stage,assetName),r=await response(a.browser_download_url,fetcher,300000);let received=0,last=0;
    await pipeline(Readable.fromWeb(r.body),new Transform({transform(chunk,_encoding,callback){
      received+=chunk.length;if(received>600*1024*1024){callback(new Error('Engine download is too large.'));return;}
      if(Date.now()-last>250){last=Date.now();onProgress({phase:'downloading',received,total:a.size,message:`Downloading Pi-Bolt · ${Math.round(received/(a.size||received)*100)}%`});}callback(null,chunk);
    }}),createWriteStream(archive));
    if(await hashFile(archive)!==expected)throw new Error('Pi-Bolt archive checksum mismatch. The current engine was kept.');
    onProgress({phase:'extracting',message:'Unpacking verified engine…'});const unpack=path.join(stage,'unpacked');await fs.mkdir(unpack);
    if(assetName.endsWith('.zip'))await extractZip(archive,{dir:unpack,onEntry(entry){if(((entry.externalFileAttributes>>>16)&0xf000)===0xa000)throw new Error('Links are not allowed in engine archives.');}});
    else await tar.x({file:archive,cwd:unpack,strict:true,filter(name,entry){if(path.isAbsolute(name)||name.split(/[\\/]/).includes('..')||['SymbolicLink','Link'].includes(entry.type))throw new Error('Unsafe path in engine archive.');return true;}});
    const engineDir=await findExecutable(unpack,platform);
    // Keep the complete release together: Pi-Bolt uses adjacent resources and notices.
    for(const required of ['package.json','LICENSE','pi-bolt.txt'])if(!existsSync(path.join(engineDir,required)))throw new Error(`Release is missing ${required}.`);
    if(platform!=='win32')await fs.chmod(binaryIn(engineDir,platform),0o755);
    const manifest={tag:release.tag_name,asset:assetName,archiveSha256:expected,binarySha256:await hashFile(binaryIn(engineDir,platform)),platform,installedAt:new Date().toISOString()};
    await fs.writeFile(path.join(engineDir,'bundle-meta.json'),JSON.stringify(manifest,null,2));
    return {stage,engineDir,manifest};
  }catch(e){await removeOwned(stage,parent).catch(()=>{});throw e;}
}

export class EngineManager {
  constructor({bundledDir,dataDir,platform=process.platform,arch=process.arch,fetcher=fetch,verifyEngine}){
    this.bundledDir=bundledDir;this.dataDir=path.join(dataDir,'managed-engine');this.platform=platform;this.asset=assetFor(platform,arch);this.fetcher=fetcher;this.verifyEngine=verifyEngine;
    this.state={automatic:true,checking:false,installing:false,available:false,lastChecked:null,error:null,phase:'idle',message:'Bundled engine ready.'};this.listeners=new Set();
  }
  async init(){
    await fs.mkdir(this.dataDir,{recursive:true});this.bundle=JSON.parse(await fs.readFile(path.join(this.bundledDir,'bundle-meta.json'),'utf8'));
    if(!TAG.test(this.bundle.tag)||!existsSync(binaryIn(this.bundledDir,this.platform)))throw new Error('The bundled Pi-Bolt engine is missing or invalid. Reinstall JoltDesk.');
    this.activeDir=this.bundledDir;this.manifest=this.bundle;
    try{const saved=JSON.parse(await fs.readFile(path.join(this.dataDir,'active.json'),'utf8'));if(TAG.test(saved.tag)&&isNewer(saved.tag,this.bundle.tag)){
      const candidate=path.join(this.dataDir,saved.tag);const manifest=JSON.parse(await fs.readFile(path.join(candidate,'bundle-meta.json'),'utf8'));
      if(manifest.tag===saved.tag&&await hashFile(binaryIn(candidate,this.platform))===manifest.binarySha256){this.activeDir=candidate;this.manifest=manifest;}
    }}catch{}
    try{const p=JSON.parse(await fs.readFile(path.join(this.dataDir,'preferences.json'),'utf8'));this.state.automatic=p.automatic!==false;}catch{}
    return this;
  }
  binary(){return binaryIn(this.activeDir,this.platform);}
  status(){return {...this.state,current:this.manifest.tag,bundled:this.bundle.tag,source:this.activeDir===this.bundledDir?'bundled':'managed update',binary:this.binary(),latest:this.latest?.tag_name||null};}
  emit(patch){Object.assign(this.state,patch);for(const f of this.listeners)f(this.status());}
  subscribe(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  async setAutomatic(value){this.state.automatic=!!value;await fs.writeFile(path.join(this.dataDir,'preferences.json'),JSON.stringify({automatic:!!value}));this.emit({});return this.status();}
  async check(){
    if(this.state.checking||this.state.installing)return this.status();
    this.emit({checking:true,error:null,message:'Checking official stable releases…'});
    try{const latest=validateRelease(await getLatest(this.fetcher),this.asset);this.latest=latest;const available=isNewer(latest.tag_name,this.manifest.tag);
      this.emit({available,lastChecked:new Date().toISOString(),message:available?`${latest.tag_name} is available.`:'Pi-Bolt is up to date.'});
    }catch(e){this.emit({error:e.message,message:'Update check unavailable. Your current engine is ready.'});}
    finally{this.emit({checking:false});}return this.status();
  }
  async install(){
    if(this.state.installing||this.state.checking)throw new Error('An engine check or update is already running.');
    if(!this.latest||!isNewer(this.latest.tag_name,this.manifest.tag))throw new Error('Check for updates first. No newer stable engine is available.');
    this.emit({installing:true,error:null});let staged;
    try{
      staged=await stageRelease({release:this.latest,assetName:this.asset,parent:this.dataDir,platform:this.platform,fetcher:this.fetcher,onProgress:p=>this.emit(p)});
      this.emit({phase:'testing',message:'Checking engine compatibility…'});await this.verifyEngine(binaryIn(staged.engineDir,this.platform));
      const destination=path.join(this.dataDir,staged.manifest.tag);
      // A previous interrupted attempt can leave this owned, inactive directory behind.
      if(destination===this.activeDir)throw new Error('The target engine is already active.');
      await removeOwned(destination,this.dataDir);await renameReady(staged.engineDir,destination);
      const pointer=path.join(this.dataDir,'active.json'),temporary=pointer+'.tmp';await fs.writeFile(temporary,JSON.stringify({tag:staged.manifest.tag}));await fs.rename(temporary,pointer);
      this.activeDir=destination;this.manifest=staged.manifest;
      this.emit({available:false,phase:'idle',message:`Updated to ${this.manifest.tag}.`});
    }catch(e){this.emit({phase:'idle',error:e.message,message:'Update failed. Your previous engine is still selected.'});throw e;}
    finally{if(staged)await removeOwned(staged.stage,this.dataDir).catch(()=>this.emit({cleanupPending:true}));this.emit({installing:false});}return this.status();
  }
  start(){const run=()=>{if(this.state.automatic)this.check();};this.initial=setTimeout(run,5000);this.initial.unref();this.interval=setInterval(run,6*60*60*1000);this.interval.unref();}
  close(){clearTimeout(this.initial);clearInterval(this.interval);this.listeners.clear();}
}
