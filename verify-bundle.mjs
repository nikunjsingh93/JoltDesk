import { promises as fs } from 'node:fs';
import path from 'node:path';
import { binaryIn, hashFile, assetFor } from './engine-updater.mjs';
const dir=path.resolve('engine-bundle');
const meta=JSON.parse(await fs.readFile(path.join(dir,'bundle-meta.json'),'utf8').catch(()=>{throw new Error('Run npm run bundle:engine before packaging.');}));
const platform=process.env.BOLT_BUILD_PLATFORM||process.platform,arch=process.env.BOLT_BUILD_ARCH||process.arch;
if(meta.asset!==assetFor(platform,arch)||meta.platform!==platform)throw new Error('Engine bundle does not match the target platform. Regenerate it before packaging.');
if(await hashFile(binaryIn(dir,platform))!==meta.binarySha256)throw new Error('Bundled engine checksum failed. Run npm run bundle:engine again.');
console.log(`Verified bundled Pi-Bolt ${meta.tag}: ${meta.asset}`);
