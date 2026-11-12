// Real Pi-Bolt engine, simulated model API: agent edits appear in Changes and can be undone.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { mockProvider, testModel } from './mock-provider.mjs';

const dir=path.resolve('work/changes-ui-'+Date.now());
const workspace=path.join(dir,'workspace');
const provider=await mockProvider();
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.mkdir(workspace,{recursive:true});
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
await fs.writeFile(path.join(workspace,'notes.txt'),'alpha\nbeta\n');
const original=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'
  ?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
const server=await startServer({dataDir:dir,autoStartUpdates:false,native:{fileAction:async()=>{}}});
const env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};
delete env.ELECTRON_RUN_AS_NODE;
const read=name=>fs.readFile(path.join(workspace,name),'utf8');
let app;
try{
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});
  const page=await app.firstWindow();
  await page.locator('#settings').click();
  await page.locator('#api-key').fill('sk-fake');
  await page.locator('#connect-button').click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await page.locator('#permission').selectOption('bypass');
  await expect(page.locator('#toast')).toContainText('Bypass active');
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-inspector').click();
  await page.locator('#panel-changes').click();
  await expect(page.locator('#changes-list')).toContainText('File edits made by the agent appear here');

  const send=async(text,previous=provider.requests.length)=>{
    await page.locator('#prompt').fill(text);
    await page.locator('#send').click();
    await expect.poll(()=>provider.requests.length).toBeGreaterThan(previous);
    await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
  };
  provider.tool('write',{path:'notes.txt',content:'alpha\nBETA\ngamma\n'});
  await send('Update the notes.');
  provider.tool('edit',{path:'notes.txt',edits:[{oldText:'gamma',newText:'delta'}]});
  await send('Rename gamma.');
  provider.tool('write',{path:'src/new.txt',content:'created\n'});
  await send('Create a file.');
  assert.equal(await read('notes.txt'),'alpha\nBETA\ndelta\n');

  const turns=page.locator('.change-turn');
  await expect(turns).toHaveCount(3);
  await expect(page.locator('#changes-count')).toHaveText('3');
  await expect(turns.nth(0)).toContainText('Create a file.');
  await expect(turns.nth(0).locator('.change-file')).toContainText('new.txt');
  await expect(turns.nth(0).locator('.change-stats')).toContainText('new');
  await expect(turns.nth(2).locator('.change-stats')).toContainText('+2 −1');

  await turns.nth(2).locator('[data-toggle]').click();
  const diff=turns.nth(2).locator('.change-diff');
  await expect(diff.locator('.diff-line.del')).toHaveText(['2−beta']);
  await expect(diff.locator('.diff-line.add')).toHaveText(['2+BETA','3+gamma']);

  await turns.nth(0).locator('[data-revert]').click();
  await expect(page.locator('#undo-dialog')).toBeVisible();
  await expect(page.locator('#undo-files')).toContainText('new.txt');
  await page.locator('#undo-confirm').click();
  await expect(page.locator('#toast')).toContainText('Restored 1 file');
  await expect.poll(()=>fs.stat(path.join(workspace,'src','new.txt')).then(()=>true,()=>false)).toBe(false);
  await expect(turns.nth(0)).toHaveClass(/undone/);

  // Undoing the first request also undoes the later edit to the same file.
  await turns.nth(2).locator('[data-undo]').click();
  await expect(page.locator('#undo-message')).toContainText('1 later request');
  await page.locator('#undo-confirm').click();
  await expect.poll(()=>read('notes.txt')).toBe('alpha\nbeta\n');
  await expect(page.locator('.change-turn.undone')).toHaveCount(3);
  await expect(page.locator('#changes-count')).toBeHidden();

  // The agent learns about the undo on the next message, without it showing in the chat.
  provider.setAnswer('Noted.');
  const before=provider.requests.length;
  await send('What changed?');
  const body=JSON.stringify(provider.requests.slice(before));
  assert.match(body,/undid earlier agent edits/);
  await expect(page.locator('#messages')).not.toContainText('undid earlier agent edits');

  // Outside edits after the agent's change need a second confirmation.
  provider.tool('write',{path:'notes.txt',content:'agent version\n'});
  await send('Rewrite the notes.');
  await fs.writeFile(path.join(workspace,'notes.txt'),'my own edit\n');
  await expect(turns).toHaveCount(4);
  await turns.nth(0).locator('[data-undo]').click();
  await page.locator('#undo-confirm').click();
  await expect(page.locator('#undo-title')).toHaveText('Files changed since');
  await page.locator('#undo-cancel').click();
  assert.equal(await read('notes.txt'),'my own edit\n');
  await turns.nth(0).locator('[data-undo]').click();
  await page.locator('#undo-confirm').click();
  await page.locator('#undo-confirm').click();
  await expect.poll(()=>read('notes.txt')).toBe('alpha\nbeta\n');

  // Checkpoints survive a reload.
  await page.reload();
  await page.locator('.open-chat').first().click();
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-inspector').click();
  await expect(page.locator('#panel-changes')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.change-turn')).toHaveCount(4);
  console.log('CHANGES UI PASS: per-request checkpoints from real write and edit tools, line diffs, file revert, cascading undo, hidden agent note, outside-edit confirmation and persistence.');
}finally{
  await app?.close();
  server.close();
  provider.close();
  globalThis.fetch=original;
}
