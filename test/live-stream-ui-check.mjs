import {_electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {startServer} from '../server.mjs';
import {mockProvider,testModel} from './mock-provider.mjs';
const dir=path.resolve('work/live-stream-ui-'+Date.now()),provider=await mockProvider();provider.setHeaderDelay(700);provider.setDelay(120);provider.setThought('I will check the request and explain the result clearly. First I inspect the requirements, then consider the simplest useful implementation.');
await fs.mkdir(path.join(dir,'agent'),{recursive:true});await fs.writeFile(path.join(dir,'agent','models.json'),JSON.stringify({providers:{openai:{baseUrl:provider.url,models:[{...testModel,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
const original=globalThis.fetch;globalThis.fetch=(url,opts)=>String(url)==='https://api.openai.com/v1/models'?Promise.resolve(new Response(JSON.stringify({data:[{id:'bolt-test'}]}))):original(url,opts);
const server=await startServer({dataDir:dir,autoStartUpdates:false}),env={...process.env,BOLT_TEST_URL:server.url,BOLT_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
  const packaged=!!process.env.BOLT_TEST_PACKAGED;
  app=await _electron.launch(packaged?{executablePath:'release/win-arm64-unpacked/JoltDesk.exe',args:[],env}:{args:['test/ui-shell.cjs'],env});
  if(packaged)await app.evaluate(()=>{
    const original=globalThis.fetch;
    globalThis.fetch=(url,options)=>String(url)==='https://api.openai.com/v1/models'?Promise.resolve(new Response('{"data":[{"id":"bolt-test"}]}')):original(url,options);
  });
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#settings').click();await page.locator('#api-key').fill('sk-fake');await page.locator('#connect-button').click();await expect(page.locator('#settings-dialog')).not.toBeVisible();
  provider.setAnswer('Here is the code:\n\n```javascript\nconsole.log("'+('x'.repeat(220))+'");\n'+('console.log(1);\n'.repeat(65))+'```');
  await page.locator('#prompt').fill('Show a live streamed answer.');await page.locator('#send').click();
  await expect(page.locator('#activity-text')).toContainText('Processing request');await page.waitForTimeout(300);await expect(page.locator('.reply-metrics.live [data-stat="time"]')).not.toHaveText('0.0s');
  await expect(page.locator('#activity-text')).toHaveText('Thinking…');await expect(page.locator('.thinking-body')).toContainText('I will');await expect(page.locator('#send')).toHaveClass(/running/);
  const earlyThought=await page.locator('.thinking-body').innerText();assert.ok(earlyThought.length<54,'Thinking was only rendered after completion.');
  await expect(page.locator('#activity-text')).toHaveText('Writing a response…');await expect(page.locator('.assistant .blocks > .markdown')).toContainText('Here is');await expect(page.locator('#send')).toHaveClass(/running/);
  const replyCode=page.locator('.answer-markdown pre').first();
  await expect.poll(()=>replyCode.evaluate(el=>el.scrollTop),{timeout:15000}).toBeGreaterThan(100);
  assert.ok(await replyCode.evaluate(el=>el.scrollWidth>el.clientWidth),'A long code line should scroll inside its block');
  await replyCode.evaluate(el=>{
    el.scrollTop-=16;
    el.scrollLeft=48;
    window.replyCodeCheck={el,top:el.scrollTop,left:el.scrollLeft,length:el.textContent.length,chatTop:document.querySelector('#scroll-area').scrollTop};
  });
  await page.waitForFunction(()=>document.querySelector('.answer-markdown pre').textContent.length>window.replyCodeCheck.length);
  const reading=await replyCode.evaluate(el=>{
    const previous=window.replyCodeCheck;
    return {same:el===previous.el,vertical:Math.abs(el.scrollTop-previous.top),horizontal:Math.abs(el.scrollLeft-previous.left),chat:Math.abs(document.querySelector('#scroll-area').scrollTop-previous.chatTop)};
  });
  assert.ok(reading.same&&reading.vertical<=2&&reading.horizontal<=2&&reading.chat<=2,'Streaming moved the code or chat scroll position');
  await replyCode.evaluate(el=>{el.scrollTop=el.scrollHeight;window.replyCodeCheck.length=el.textContent.length;});
  await page.waitForFunction(()=>document.querySelector('.answer-markdown pre').textContent.length>window.replyCodeCheck.length);
  assert.ok(await replyCode.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<=2),'Returning to the bottom should follow new code');
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});await expect(page.locator('.reply-metrics [data-stat="cost"]')).not.toBeVisible();
  const speed=Number.parseFloat((await page.locator('.reply-metrics [data-stat="speed"]').innerText()).replace(/^~/,''));assert.ok(speed>0&&speed<100);await expect(page.locator('.reply-metrics [data-stat="speed"]')).toContainText('~');
  provider.setAnswer();
  // Buffer a complete response for 1.5s, then release it all at once: the old app showed thousands of tok/s here.
  provider.setBuffered(true);provider.setHeaderDelay(1500);provider.setDelay(0);await page.locator('#prompt').fill('Buffer this reply to verify the clock.');await page.locator('#send').click();await expect(page.locator('#send')).toHaveClass(/running/);await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:15000});
  const last=page.locator('.reply-metrics').last(),time=Number.parseFloat(await last.locator('[data-stat="time"]').innerText());assert.ok(time>=1.5);await expect(last.locator('[data-stat="speed"]')).not.toBeVisible();
  // File-writing arguments contain the generated code, even when there is no assistant text delta.
  provider.setBuffered(false);provider.setHeaderDelay(0);provider.setDelay(80);provider.setFragmentTools(true);await page.locator('#permission').selectOption('bypass');
  provider.tool('write',{path:'live-code.html',content:'<!doctype html>\n<html>\n<head><title>Streamed code</title></head>\n<body>\n<h1>Hello</h1>\n'+('<p>Streamed content</p>\n'.repeat(72))+'</body></html>'});
  await page.locator('#prompt').fill('Write the file using a tool.');await page.locator('#send').click();await expect(page.locator('#activity-text')).toHaveText('Writing file content…');
  await expect(page.locator('.tool-stream-body code').last()).toContainText('<!doctype html>');await expect(page.locator('#send')).toHaveClass(/running/);
  const preview=page.locator('.tool-stream-body').last();
  await expect.poll(()=>preview.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  await preview.evaluate(el=>{
    el.scrollTop-=16;
    window.codeScrollCheck={el,top:el.scrollTop,textLength:el.textContent.length};
  });
  await page.waitForFunction(()=>window.codeScrollCheck.el.textContent.length>window.codeScrollCheck.textLength,{},{timeout:3000});
  const keptPosition=await preview.evaluate(el=>el===window.codeScrollCheck.el&&Math.abs(el.scrollTop-window.codeScrollCheck.top)<=2);
  assert.ok(keptPosition,'Streamed code reset a small upward scroll');
  await preview.evaluate(el=>{el.scrollTop=el.scrollHeight;window.codeScrollCheck.textLength=el.textContent.length;});
  await page.waitForFunction(()=>window.codeScrollCheck.el.textContent.length>window.codeScrollCheck.textLength,{},{timeout:3000});
  assert.ok(await preview.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<=2),'Scrolling back to the end did not resume following the code');
  await expect(page.locator('#send')).not.toHaveClass(/running/,{timeout:20000});assert.ok((await fs.readFile(path.join(dir,'workspace','live-code.html'),'utf8')).includes('Streamed content'));
  await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:'work/screenshots/joltdesk-streaming-fixed.png'});assert.deepEqual(errors,[]);
  console.log('STREAM UI PASS: live thinking/text and tool code; generation-only speed estimates; buffered replies without server timing cannot produce false rates.');
}finally{await app?.close();server.close();provider.close();globalThis.fetch=original;}
