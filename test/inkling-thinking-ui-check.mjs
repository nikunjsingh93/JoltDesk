import {_electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startServer} from '../server.mjs';
process.env.BOLT_FIXTURE_ONLY='1';const {inklingFixture}=await import('./inkling-thinking.test.mjs');delete process.env.BOLT_FIXTURE_ONLY;
const fixture=await inklingFixture(),dir=path.resolve('work/inkling-thinking-ui-'+Date.now()),server=await startServer({dataDir:dir,autoStartUpdates:false}),env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#settings').click();await page.locator('#provider').selectOption('local');await page.locator('#base-url').fill(fixture.url+'/v1');await page.locator('#connection-name').fill('Fixture');await page.locator('#connect-button').click();await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await page.locator('#add-conversation').click();await page.locator('#model').selectOption('Inkling-2-Mini-Q4_K_M.gguf');
  await expect(page.locator('#thinking option')).toHaveText(['Thinking · None','Thinking · Minimal','Thinking · Low','Thinking · Medium','Thinking · High','Thinking · Extra high','Thinking · Max']);
  await expect(page.locator('#thinking')).toHaveAttribute('title',/can still reason/);
  for(const level of ['off','high']){
    await page.locator('#thinking').selectOption(level);await page.locator('#prompt').fill('Reply briefly.');const count=fixture.requests.length;await page.locator('#send').click();await expect.poll(()=>fixture.requests.length).toBeGreaterThan(count);await expect(page.locator('#send')).not.toHaveClass(/running/);assert.equal(fixture.requests.at(-1).chat_template_kwargs.reasoning_effort,level==='off'?'none':level);
  }
  await page.reload();await page.locator('.open-chat').click();await expect(page.locator('#thinking')).toHaveValue('high');
  await page.locator('#model').selectOption('other-model');await expect(page.locator('#thinking')).not.toBeVisible();
  if(errors.length)throw new Error(errors.join('\n'));console.log('INKLING UI PASS: effort choices, None label, request values, persistence, and other model.');
}finally{await app?.close();server.close();fixture.close();}
