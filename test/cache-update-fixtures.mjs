import {promises as fs,createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {getLatest,validateRelease} from '../engine-updater.mjs';
const release=validateRelease(await getLatest(),'pi-bolt-win32-x64.zip');
await fs.mkdir('work/update-fixtures',{recursive:true});await fs.writeFile('work/latest-release.json',JSON.stringify(release,null,2));
for(const name of ['SHA256SUMS','SHA256SUMS.sig','pi-bolt-win32-x64.zip']){
  const r=await fetch(release.assets.find(a=>a.name===name).browser_download_url);if(!r.ok)throw new Error(`Download failed (${r.status})`);
  await pipeline(Readable.fromWeb(r.body),createWriteStream('work/update-fixtures/'+name));console.log('Cached official fixture:',name);
}
