// Terminal tab and instruction files with the real engine and a simulated model.
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { mockProvider, testModel } from './mock-provider.mjs';

const windows=process.platform==='win32';
const dir=path.resolve('work/terminal-ui-'+Date.now());
const project=path.join(dir,'project');
const provider=await mockProvider();
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.mkdir(path.join(project,'src'),{recursive:true});
await fs.writeFile(path.join(project,'AGENTS.md'),'PROJECT_RULE: prefer small functions.\n');
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel]}}}));
const original=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'
  ?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
const opened=[];
const server=await startServer({dataDir:dir,autoStartUpdates:false,native:{fileAction:async(action,file)=>opened.push({action,file})}});
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
  await page.locator('#project-name').fill('Terminal project');
  await page.locator('#project-path').fill(project);
  await page.locator('#project-form button[type=submit]').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-inspector').click();

  // Instructions: the project's AGENTS.md is listed and opens; personal instructions reach the model.
  await page.locator('#panel-files').click();
  const instructions=page.locator('#inspector-instructions');
  await expect(instructions).toContainText('AGENTS.md');
  await expect(instructions).toContainText('This project');
  await expect(instructions.locator('[data-create]')).toHaveCount(0);
  await instructions.locator(`[data-path="${path.join(project,'AGENTS.md').replace(/\\/g,'\\\\')}"]`).click();
  await expect.poll(()=>opened.at(-1)?.file).toBe(path.join(project,'AGENTS.md'));

  await page.locator('#settings').click();
  await page.locator('#personal-instructions').fill('PERSONAL_RULE: answer like a pirate.');
  await page.locator('#save-instructions').click();
  await expect(page.locator('#instructions-feedback')).toContainText('Saved');
  await page.locator('#settings-dialog .close-dialog').click();
  await expect(instructions).toContainText('Personal instructions');
  const send=async(text,previous=provider.requests.length)=>{
    await page.locator('#prompt').fill(text);
    await page.locator('#send').click();
    await expect.poll(()=>provider.requests.length).toBeGreaterThan(previous);
    await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
  };
  await send('Hello');
  let body=JSON.stringify(provider.requests.at(-1));
  assert.match(body,/PROJECT_RULE/);
  assert.match(body,/PERSONAL_RULE/);
  // Changing personal instructions applies to an already open chat on its next message.
  await page.locator('#settings').click();
  await page.locator('#personal-instructions').fill('UPDATED_RULE');
  await page.locator('#save-instructions').click();
  await expect(page.locator('#instructions-feedback')).toContainText('Saved');
  await page.locator('#settings-dialog .close-dialog').click();
  await send('Again');
  body=JSON.stringify(provider.requests.at(-1));
  assert.match(body,/UPDATED_RULE/);
  assert.doesNotMatch(body,/PERSONAL_RULE/);

  // Terminal: run commands, cd, stop and watch the agent's commands.
  await page.locator('#panel-terminal').click();
  await expect(page.locator('#terminal-cwd')).toHaveText(project);
  const command=page.locator('#terminal-command');
  await expect(command).toBeFocused();
  await command.fill(windows?'Write-Output "hello from terminal"':'echo "hello from terminal"');
  await command.press('Enter');
  const entries=page.locator('.term-entry');
  await expect(entries.last()).toHaveClass(/done/,{timeout:20000});
  await expect(entries.last().locator('.term-out')).toHaveText('hello from terminal\n');

  await command.fill('cd src');
  await command.press('Enter');
  await expect(page.locator('#terminal-cwd')).toHaveText(path.join(project,'src'));
  await command.press('ArrowUp');
  await expect(command).toHaveValue('cd src');
  await command.fill('');

  await command.fill(windows?'Write-Output waiting; Start-Sleep -Seconds 60':'echo waiting; sleep 60');
  await command.press('Enter');
  await expect(entries.last().locator('.term-out')).toHaveText('waiting\n',{timeout:20000});
  await expect(page.locator('#terminal-count')).toHaveText('1');
  await entries.last().locator('[data-stop]').click();
  await expect(entries.last()).toHaveClass(/stopped/,{timeout:15000});
  await expect(page.locator('#terminal-count')).toBeHidden();

  await page.locator('#permission').selectOption('bypass');
  await expect(page.locator('#toast')).toContainText('Bypass active');
  provider.tool(windows?'powershell':'bash',{command:windows?'Write-Output agent-line-1; Start-Sleep -Milliseconds 800; Write-Output agent-line-2':'echo agent-line-1; sleep 0.8; echo agent-line-2'});
  await send('Run a command.');
  const agent=page.locator('.term-entry.agent');
  await expect(agent).toHaveCount(1);
  await expect(agent.locator('.term-out')).toHaveText(/agent-line-1\s+agent-line-2/);
  await expect(agent).toHaveClass(/done/);

  await page.locator('#terminal-clear').click();
  await expect(entries).toHaveCount(0);

  // A general conversation can create its own AGENTS.md.
  await page.locator('#add-conversation').click();
  await expect(page.locator('#status')).toHaveText('Pi-Bolt connected');
  await page.locator('#panel-files').click();
  await page.locator('#inspector-instructions [data-create]').click();
  await expect(page.locator('#toast')).toContainText('Created AGENTS.md');
  const created=path.join(dir,'workspace','AGENTS.md');
  assert.match(await fs.readFile(created,'utf8'),/# Project instructions/);
  assert.equal(opened.at(-1).file,created);
  console.log('TERMINAL AND INSTRUCTIONS UI PASS: project and personal instructions reach the model and apply to open chats, open/create AGENTS.md, terminal commands, cd, history, stop, live agent command output and clear.');
}finally{
  await app?.close();
  server.close();
  provider.close();
  globalThis.fetch=original;
}
