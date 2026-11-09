import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assetFor, getLatest, stageRelease, removeOwned } from './engine-updater.mjs';
const platform=process.env.BOLT_BUILD_PLATFORM||process.platform,arch=process.env.BOLT_BUILD_ARCH||process.arch;
const staging=path.resolve('work','bundle-staging'),target=path.resolve('engine-bundle');
const release=await getLatest();
const result=await stageRelease({release,assetName:assetFor(platform,arch),parent:staging,platform,onProgress:p=>{if(p.phase!=='downloading'||p.received===p.total)console.log(p.message);}});
try{await removeOwned(target,path.resolve('.'));await fs.rename(result.engineDir,target);console.log(`Bundled ${result.manifest.tag} (${result.manifest.asset}) in ${target}`);}finally{await removeOwned(result.stage,staging);}
