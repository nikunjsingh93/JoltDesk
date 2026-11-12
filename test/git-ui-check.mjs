// Git tab against a fixture repository and bare remote, with the real engine and a simulated model.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { mockProvider, testModel } from './mock-provider.mjs';

const dir=path.resolve('work/git-ui-'+Date.now());
const repo=path.join(dir,'repo'),remote=path.join(dir,'remote.git');
// Keep Git from finding the JoltDesk checkout above the fixture folders.
process.env.GIT_CEILING_DIRECTORIES=path.resolve('work');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.mkdir(repo,{recursive:true});
git(dir,'init','-q','--bare',remote);
git(repo,'init','-q','-b','main');
git(repo,'config','user.name','JoltDesk Test');git(repo,'config','user.email','test@example.invalid');git(repo,'config','commit.gpgsign','false');
await fs.writeFile(path.join(repo,'notes.txt'),'alpha\nbeta\n');
git(repo,'add','.');git(repo,'commit','-q','-m','Initial notes');
git(repo,'remote','add','origin',remote);git(repo,'push','-q','-u','origin','main');

const provider=await mockProvider();
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
const original=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'
  ?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
const server=await startServer({dataDir:dir,autoStartUpdates:false,native:{fileAction:async()=>{}}});
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

  // A general conversation's workspace is not a repository.
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-inspector').click();
  await page.locator('#panel-git').click();
  await expect(page.locator('#git-empty')).toContainText('not a Git repository');

  await page.locator('#add-project').click();
  await page.locator('#project-name').fill('Fixture repo');
  await page.locator('#project-path').fill(repo);
  await page.locator('#project-form button[type=submit]').click();
  await expect(page.locator('#project-label')).toHaveText('Fixture repo');
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await expect(page.locator('.git-branch')).toContainText('⎇ main');
  await expect(page.locator('.git-branch')).toContainText('up to date');
  await expect(page.locator('#git-files')).toContainText('working tree is clean');

  await fs.writeFile(path.join(repo,'notes.txt'),'alpha\nBETA\ngamma\n');
  await fs.mkdir(path.join(repo,'src'));
  await fs.writeFile(path.join(repo,'src','new file.txt'),'fresh\n');
  await page.locator('[data-git="refresh"]').click();
  const rows=page.locator('.git-file');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#git-count')).toHaveText('2');
  await expect(page.locator('.git-file[data-path="notes.txt"] .git-code')).toHaveText('M');
  await expect(page.locator('.git-file[data-path="src/new file.txt"] .git-code')).toHaveText('U');
  await page.locator('.git-file[data-path="notes.txt"] [data-toggle]').click();
  await expect(page.locator('.git-file[data-path="notes.txt"] .diff-line.add')).toHaveText(['2+BETA','3+gamma']);
  await expect(page.locator('.git-file[data-path="notes.txt"] .change-stats')).toContainText('+2 −1');

  // The commit message comes from the chat's model without adding to the conversation.
  provider.setAnswer('Update notes with new entries');
  const before=provider.requests.length;
  await page.locator('.git-file[data-path="src/new file.txt"] [data-select]').uncheck();
  await expect(page.locator('#git-commit')).toHaveText('Commit 1 file');
  await page.locator('#git-write').click();
  await expect(page.locator('#git-message')).toHaveValue('Update notes with new entries',{timeout:30000});
  assert.equal(provider.requests.length,before+1);
  const request=JSON.stringify(provider.requests.at(-1));
  assert.match(request,/Write a Git commit message/);
  assert.match(request,/\+BETA/);
  assert.doesNotMatch(request,/new file\.txt/);
  assert.ok(provider.requests.at(-1).tools===undefined||provider.requests.at(-1).tools.length===0);
  await expect(page.locator('#messages .message')).toHaveCount(0);

  await page.locator('#git-commit').click();
  await expect(page.locator('#toast')).toContainText('Committed');
  assert.equal(git(repo,'log','-1','--format=%s'),'Update notes with new entries');
  assert.equal(git(repo,'show','--name-only','--format=','HEAD'),'notes.txt');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.git-commit-row').first()).toContainText('Update notes with new entries');
  await expect(page.locator('.git-branch')).toContainText('↑1');

  await page.locator('[data-git="push"]').click();
  await expect(page.locator('#toast')).toContainText('Pushed to origin/main');
  await expect(page.locator('.git-branch')).toContainText('up to date');
  assert.equal(git(remote,'log','-1','--format=%s','main'),'Update notes with new entries');

  await page.locator('#git-message').fill('');
  await page.locator('#git-commit').click();
  await expect(page.locator('#toast')).toContainText('Write a commit message first');
  console.log('GIT UI PASS: non-repository message, project status, file diffs, AI commit message without chat history, selective commit, push and upstream tracking.');
}finally{
  await app?.close();
  server.close();
  provider.close();
  globalThis.fetch=original;
}
