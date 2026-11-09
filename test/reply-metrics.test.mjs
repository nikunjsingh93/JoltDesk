import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completedMetrics,displayMetrics,elapsedText} from '../public/reply-metrics.mjs';
test('legacy request averages and buffered bursts are not shown as generation speed',()=>{
  const message={durationMs:6115,usage:{input:69,output:55,totalTokens:732,cost:{total:0,totalFromProvider:false}},replyMetrics:{durationMs:3.0776,output:55,estimated:false,tokensPerSecond:17871}};
  const metric=displayMetrics(message,0);assert.equal(metric.durationMs,6115);assert.equal(metric.rate,null);assert.equal(metric.costText,'');assert.equal(elapsedText(metric.durationMs),'6.1 secs');
  const finished=completedMetrics(message,3.0776,{firstDeltaMs:6000,lastDeltaMs:6003,deltaCount:55});assert.equal(finished.durationMs,6115);assert.equal(finished.tokensPerSecond,null);
});
test('live rates wait for a useful sample and preserve estimates without invented pricing',()=>{
  const m={live:true,startedAt:0,generationStartedAt:1000,content:[{type:'thinking',thinking:'x'.repeat(120)}],usage:{input:0,output:0}};
  assert.equal(displayMetrics(m,1010).rate,null);assert.equal(displayMetrics(m,1010).costText,'');assert.equal(displayMetrics(m,3000).rate,14.5);assert.equal(displayMetrics(m,3000).estimated,true);assert.equal(displayMetrics(m,3000).rateEstimated,true);
  assert.equal(displayMetrics({usage:{output:10,input:50,cost:{total:.00000004,totalFromProvider:false}}},0).costText,'<$0.000001 est.');
  assert.equal(displayMetrics({usage:{output:10,input:50,cost:{total:0,totalFromProvider:true}}},0).costText,'$0.00');
  assert.equal(completedMetrics({usage:{input:1,output:55}},3).tokensPerSecond,null);assert.equal(elapsedText(3),'<0.1 sec');
});
test('minute formatting and native live counts work before a speed sample exists',()=>{assert.equal(elapsedText(96000),'1 min 36 secs');assert.equal(elapsedText(60000),'1 min 0 secs');assert.equal(elapsedText(3661000),'1 hr 1 min 1 secs');const m={live:true,startedAt:0,content:[{type:'thinking',thinking:'a long thought'}],serverTimings:{predicted_n:1,predicted_ms:10}};assert.equal(displayMetrics(m,10).output,1);assert.equal(displayMetrics(m,10).estimated,false);assert.equal(displayMetrics(m,10).rate,null);});
test('exact server generation speed wins over request time, includes thinking, survives reload and live updates',()=>{
 const timings={predicted_n:81,predicted_ms:4000,predicted_per_second:20,prompt_ms:6000};
 const m={durationMs:10000,usage:{output:81,input:500},content:[]};m.replyMetrics=completedMetrics(m,10000,{timings});
 assert.equal(m.replyMetrics.rateSource,'server-generation');assert.equal(displayMetrics(m,0).rate,20);assert.equal(displayMetrics(m,0).durationMs,10000);assert.equal(displayMetrics(m,0).rateEstimated,false);
 assert.equal(displayMetrics({...m,live:true,startedAt:0,serverTimings:timings},10000).rate,20);
 assert.equal(completedMetrics(m,10000,{timings:{...timings,predicted_per_second:undefined}}).tokensPerSecond,20);
 assert.equal(completedMetrics(m,10000,{timings:{predicted_n:81,predicted_ms:0,predicted_per_second:Infinity}}).tokensPerSecond,null);
});
