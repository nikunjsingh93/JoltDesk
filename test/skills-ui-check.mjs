// Skills with the real engine and a simulated model.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { mockProvider, testModel } from './mock-provider.mjs';

const dir=path.resolve('work/skills-ui-'+Date.now());
const project=path.join(dir,'project'),download=path.join(dir,'download','lint-fixer');
const provider=await mockProvider();
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.mkdir(path.join(project,'.agents','skills','deploy'),{recursive:true});
await fs.writeFile(path.join(project,'.agents','skills','deploy','SKILL.md'),'---\nname: deploy\ndescription: PROJECT_DEPLOY_DESCRIPTION. Use when deploying.\n---\n\nDEPLOY_BODY_MARKER: run the checks first.\n');
await fs.mkdir(download,{recursive:true});
await fs.writeFile(path.join(download,'SKILL.md'),'---\nname: lint-fixer\ndescription: Fix lint errors. Use for lint failures.\n---\nBody\n');
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
const original=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'
  ?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
const opened=[];
const server=await startServer({dataDir:dir,autoStartUpdates:false,native:{fileAction:async(action,file)=>opened.push({action,file}),pickFolder:async()=>download}});
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
  await page.locator('#add-project').click();
  await page.locator('#project-name').fill('Skills project');
  await page.locator('#project-path').fill(project);
  await page.locator('#project-form button[type=submit]').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await page.locator('#permission').selectOption('read');
  await expect(page.locator('#toast')).toContainText('Permissions updated');

  // Create a personal skill in Settings.
  await page.locator('#settings').click();
  await page.locator('#new-skill').click();
  await page.locator('#new-skill-name').fill('Release Notes');
  await expect(page.locator('#new-skill-name')).toHaveValue('release-notes');
  await page.locator('#new-skill-description').fill('PERSONAL_RELEASE_DESCRIPTION. Use when asked for release notes.');
  await page.locator('#create-skill').click();
  await expect(page.locator('#personal-skills .skill-row')).toHaveCount(1);
  await expect(page.locator('#skills-feedback')).toContainText('Skill created');
  const created=path.join(dir,'skills','release-notes','SKILL.md');
  assert.equal(opened.at(-1).file,created);
  assert.match(await fs.readFile(created,'utf8'),/name: release-notes/);
  await page.locator('#import-skill').click();
  await expect(page.locator('#personal-skills .skill-row')).toHaveCount(2);
  await expect(page.locator('#skills-feedback')).toContainText('Skill imported');
  await page.locator('#settings-dialog .close-dialog').click();

  const send=async text=>{
    const previous=provider.requests.length;
    await page.locator('#prompt').fill(text);await page.locator('#prompt').press('Enter');
    await expect.poll(()=>provider.requests.length).toBeGreaterThan(previous);
    await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
    return JSON.stringify(provider.requests.at(-1));
  };
  let body=await send('Hello');
  assert.match(body,/PERSONAL_RELEASE_DESCRIPTION/);
  assert.match(body,/lint-fixer/);
  assert.doesNotMatch(body,/PROJECT_DEPLOY_DESCRIPTION/);

  // Project skills need an explicit opt-in from the Files tab.
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-inspector').click();
  await page.locator('#panel-files').click();
  const skills=page.locator('#inspector-skills');
  await expect(skills.locator('.skill-trust')).toContainText('This project has 1 skill');
  await skills.locator('[data-project-skills="on"]').click();
  await expect(skills.locator('.skill-row')).toHaveCount(3);
  body=await send('Deploy please');
  assert.match(body,/PROJECT_DEPLOY_DESCRIPTION/);

  // Turning a skill off removes it from the next request.
  await skills.locator('.skill-row:has-text("release-notes") input[type=checkbox]').uncheck();
  await expect(skills.locator('.skill-row:has-text("release-notes") .skill-title')).toContainText('off');
  body=await send('Anything else');
  assert.doesNotMatch(body,/PERSONAL_RELEASE_DESCRIPTION/);
  assert.match(body,/PROJECT_DEPLOY_DESCRIPTION/);

  // "/" suggests active skills and Enter completes instead of sending.
  const prompt=page.locator('#prompt');
  await prompt.fill('');await prompt.pressSequentially('/');
  await expect(page.locator('#slash-menu')).toBeVisible();
  await expect(page.locator('#slash-menu .slash-item')).toHaveCount(2);
  await expect(page.locator('#slash-menu')).not.toContainText('release-notes');
  await prompt.pressSequentially('dep');
  await expect(page.locator('#slash-menu .slash-item')).toHaveCount(1);
  const before=provider.requests.length;
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('/skill:deploy ');
  assert.equal(provider.requests.length,before);
  await prompt.pressSequentially('to staging');
  await prompt.press('Enter');
  await expect.poll(()=>provider.requests.length).toBeGreaterThan(before);
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
  body=JSON.stringify(provider.requests.at(-1));
  assert.match(body,/DEPLOY_BODY_MARKER/);
  assert.match(body,/to staging/);

  // Open and remove.
  await skills.locator('[data-open*="deploy"]').click();
  await expect.poll(()=>opened.at(-1)?.file).toBe(path.join(project,'.agents','skills','deploy','SKILL.md'));
  await page.locator('#settings').click();
  await page.locator('#personal-skills .skill-row:has-text("lint-fixer") [data-ask-remove]').click();
  await page.locator('#personal-skills .skill-row:has-text("lint-fixer") [data-remove]').click();
  await expect(page.locator('#personal-skills .skill-row')).toHaveCount(1);
  await assert.rejects(fs.stat(path.join(dir,'skills','lint-fixer')));
  assert.equal((await fs.readdir(path.join(dir,'trash','skills'))).length,1);
  console.log('SKILLS UI PASS: create and import personal skills, automatic listing in Read mode, project opt-in, toggling off, slash suggestions, /skill: expansion with arguments, open and remove.');
}finally{
  await app?.close();
  server.close();
  provider.close();
  globalThis.fetch=original;
}
