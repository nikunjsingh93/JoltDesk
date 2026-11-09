import { _electron,expect } from '@playwright/test';
import {promises as fs,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {startServer} from '../server.mjs';
const dir=path.resolve('work/update-ui-'+Date.now()),bundle=path.join(dir,'bundled');await fs.mkdir(bundle,{recursive:true});
await fs.writeFile(path.join(bundle,'pi-bolt.exe'),'old-engine-fixture');await fs.writeFile(path.join(bundle,'bundle-meta.json'),JSON.stringify({tag:'bolt-v1.1.3',platform:'win32'}));
const release=JSON.parse(await fs.readFile('work/latest-release.json','utf8'));
const updateFetcher=async url=>String(url).includes('/releases/latest')?new Response(JSON.stringify(release)):new Response(Readable.toWeb(createReadStream(path.join('work/update-fixtures',new URL(url).pathname.split('/').at(-1)))));
const server=await startServer({dataDir:dir,engineDir:bundle,autoStartUpdates:false,updateFetcher});
const env={...process.env,BOLT_TEST_URL:server.url};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});const page=await app.firstWindow();await page.locator('#settings').click();
  await expect(page.locator('#engine-version')).toHaveText('v1.1.3');await page.locator('#check-engine').click();await expect(page.locator('#install-engine')).toBeVisible();
  await page.locator('#install-engine').click();await expect(page.locator('#engine-progress')).toBeVisible();await expect(page.locator('#engine-version')).toHaveText('v1.1.4',{timeout:60000});
  await expect(page.locator('#engine-source')).toContainText('Managed update');await expect(page.locator('#install-engine')).not.toBeVisible();
  await page.locator('.close-dialog').first().click();await page.locator('#new-chat').click();await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  const selected=await page.evaluate(async()=>{const r=await fetch('/api/config',{headers:{'X-Bolt-Token':window.BOLT_TOKEN}});return (await r.json()).binary;});
  if(!selected.includes(path.join('managed-engine','bolt-v1.1.4')))throw new Error('GUI did not activate managed engine.');
  console.log('UPDATE UI PASS: discover release, show progress, verify/install signed real archive, select managed engine and start an RPC chat.');
}finally{await app?.close();server.close();}
