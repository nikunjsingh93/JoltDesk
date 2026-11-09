import {_electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {startServer} from '../server.mjs';
import {mockProvider,testModel} from './mock-provider.mjs';
const dir=path.resolve('work/chat-refinements-'+Date.now()),provider=await mockProvider();
provider.setThought(Array.from({length:260},(_,i)=>`Thought ${i}: reviewing the next detail.\n`).join(''));provider.setDelay(3);
await fs.mkdir(path.join(dir,'agent'),{recursive:true});
await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[testModel,{...testModel,id:'bolt-plain',name:'Plain model',reasoning:false}]}}}));
const original=globalThis.fetch;globalThis.fetch=(url,opts)=>String(url)==='https://api.openai.com/v1/models'?Promise.resolve(new Response(JSON.stringify({data:[{id:'bolt-test'},{id:'bolt-plain'}]}))):original(url,opts);
const server=await startServer({dataDir:dir,autoStartUpdates:false}),env={...process.env,BOLT_TEST_URL:server.url};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
  app=await _electron.launch({args:['test/ui-shell.cjs'],env});const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#settings').click();await page.locator('#api-key').fill('sk-fake');await page.locator('#connect-button').click();await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await expect(page.locator('#thinking')).toBeVisible();await page.locator('#model').selectOption('bolt-plain');await expect(page.locator('#thinking')).not.toBeVisible();await page.locator('#model').selectOption('bolt-test');await expect(page.locator('#thinking')).toBeVisible();
  await page.locator('#thinking').selectOption('medium');await page.locator('#prompt').fill('Show a streamed example with a longer question that demonstrates the narrower user bubble.');await page.locator('#send').click();
  await page.waitForFunction(()=>{const b=document.querySelector('.thinking-body');return b&&b.scrollHeight>b.clientHeight+100;});
  await expect(page.locator('.reply-metrics.live [data-stat="speed"]').last()).toContainText('tok/s');
  await page.waitForTimeout(120);
  const gap=await page.locator('.thinking-body').last().evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight);assert.ok(gap<5,`Thinking panel did not follow newest text (${gap}px).`);
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:30000});
  assert.equal(await page.locator('footer').count(),0);
  const bubble=await page.locator('.message.user').first().boundingBox(),assistant=await page.locator('.message.assistant').first().boundingBox();assert.ok(bubble.width<=assistant.width*.7);assert.ok(bubble.x>assistant.x);
  const avatar=await page.locator('.assistant .avatar').first().boundingBox(),svg=await page.locator('.assistant .avatar svg').first().boundingBox();assert.ok(svg.y>=avatar.y&&svg.y+svg.height<=avatar.y+avatar.height);
  const context=await page.locator('#context').boundingBox(),hint=await page.locator('.send-hint').boundingBox();assert.ok(context.x<hint.x);
  const firstSpeed=await page.locator('.reply-metrics [data-stat="speed"]').first().textContent();await page.waitForTimeout(250);assert.equal(await page.locator('.reply-metrics [data-stat="speed"]').first().textContent(),firstSpeed);
  // Switch from no tools to bypass during generation, without restarting the stream.
  await page.locator('#prompt').fill('Create the requested file when permissions allow it.');await page.locator('#send').click();await expect(page.locator('.reply-metrics.live')).toBeVisible();
  provider.tool('write',{path:'switched-to-bypass.html',content:'<h1>Bypass works</h1>'});await expect(page.locator('#permission')).toBeEnabled();await page.locator('#permission').selectOption('bypass');
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:30000});assert.equal(await fs.readFile(path.join(dir,'workspace','switched-to-bypass.html'),'utf8'),'<h1>Bypass works</h1>');
  const enabled=provider.requests.find(r=>r.tools?.some(t=>(t.name||t.function?.name)==='write'));assert.ok(enabled,'Write tool was not declared after bypass.');assert.ok(!JSON.stringify(enabled.input.filter(m=>m.role==='system')).includes('<tools>\\n(none)'));
  assert.ok(await page.locator('.reply-metrics').count()>=3);await expect(page.locator('#activity-text')).not.toHaveText('Connecting to model…');
  await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:'work/screenshots/joltdesk-refined-chat.png'});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('REFINEMENTS PASS: thinking capability visibility, live tail-follow, reply stats, bubble widths, logo bounds, context placement, and mid-generation bypass file write.');
}finally{await app?.close();server.close();provider.close();globalThis.fetch=original;}
