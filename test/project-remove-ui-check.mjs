// Removing a project deletes its chats from JoltDesk but leaves the folder alone.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { mockProvider, testModel } from './mock-provider.mjs';

const dir=path.resolve('work/project-remove-'+Date.now());
const keep=path.join(dir,'keep'),remove=path.join(dir,'remove');
const provider=await mockProvider();
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.mkdir(keep,{recursive:true});await fs.mkdir(remove,{recursive:true});
await fs.writeFile(path.join(remove,'important.txt'),'do not delete\n');
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
const original=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'
  ?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
const server=await startServer({dataDir:dir,autoStartUpdates:false});
const env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});
  const page=await app.firstWindow();
  await page.locator('#settings').click();
  await page.locator('#api-key').fill('sk-fake');
  await page.locator('#connect-button').click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  const addProject=async(name,folder)=>{
    await page.locator('#add-project').click();
    await page.locator('#project-name').fill(name);
    await page.locator('#project-path').fill(folder);
    await page.locator('#project-form button[type=submit]').click();
    await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  };
  const send=async text=>{
    const previous=provider.requests.length;
    await page.locator('#prompt').fill(text);await page.locator('#send').click();
    await expect.poll(()=>provider.requests.length).toBeGreaterThan(previous);
    await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
  };
  await addProject('Keep me',keep);
  await send('Chat in the kept project');
  await addProject('Remove me',remove);
  await send('First chat to remove');
  await page.locator('.project-tree:has-text("Remove me") .project-new-chat').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await send('Second chat to remove');
  const removedProject=page.locator('.project-tree:has-text("Remove me")');
  await expect(removedProject.locator('.chat-row')).toHaveCount(2);

  // Removal is refused while one of the project's chats is replying.
  provider.setDelay(400);
  await page.locator('#prompt').fill('A slow reply');await page.locator('#send').click();
  await expect(page.locator('#send')).toHaveClass(/running/);
  const projectId=await removedProject.getAttribute('data-project-id');
  const refused=await page.evaluate(async id=>{const r=await fetch('/api/projects/'+id,{method:'DELETE',headers:{'X-Bolt-Token':window.BOLT_TOKEN}});return {status:r.status,body:await r.json()};},projectId);
  assert.equal(refused.status,409);assert.match(refused.body.error,/Stop this project/);
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:30000});
  provider.setDelay(8);

  await removedProject.locator('.project-actions').click();
  await page.locator('#remove-project').click();
  await expect(page.locator('#remove-project-dialog')).toBeVisible();
  await expect(page.locator('#remove-project-chats')).toHaveText('Its 2 chats are deleted too.');
  await expect(page.locator('#remove-project-path')).toHaveText(remove);
  await page.locator('#cancel-remove-project').click();
  await expect(removedProject).toHaveCount(1);

  await removedProject.locator('.project-actions').click();
  await page.locator('#remove-project').click();
  await page.locator('#confirm-remove-project').click();
  await expect(page.locator('#toast')).toContainText('Project removed');
  await expect(page.locator('.project-tree')).toHaveCount(1);
  await expect(page.locator('.project-tree')).toContainText('Keep me');
  await expect(page.locator('#chat-title')).toHaveText('New conversation');
  assert.equal(await fs.readFile(path.join(remove,'important.txt'),'utf8'),'do not delete\n');

  await page.reload();
  await expect(page.locator('.project-tree')).toHaveCount(1);
  await page.locator('.project-tree .project-toggle').click().catch(()=>{});
  const config=await page.evaluate(async()=>(await fetch('/api/config',{headers:{'X-Bolt-Token':window.BOLT_TOKEN}})).json());
  assert.deepEqual(config.projects.map(p=>p.name),['Keep me']);
  assert.equal(config.chats.length,1);
  assert.equal(config.chats[0].title,'Chat in the kept project');
  const trash=await fs.readdir(path.join(dir,'trash'));
  assert.equal(trash.length,2);
  console.log('PROJECT REMOVE UI PASS: options menu, confirmation details, cancel, refusal while running, chats archived, folder untouched, other project kept, survives reload.');
}finally{
  await app?.close();
  server.close();
  provider.close();
  globalThis.fetch=original;
}
