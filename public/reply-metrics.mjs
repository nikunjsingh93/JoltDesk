export function outputCount(message){
  const usage=message.usage||{};
  const reported=Number.isFinite(usage.output)&&(usage.output>0||usage.input>0||usage.cacheRead>0||usage.totalTokens>0);
  if(reported)return {output:usage.output,estimated:false};
  const chars=(message.content||[]).filter(Boolean).map(c=>c.text||c.thinking||(c.type==='toolCall'?(c.argumentText||JSON.stringify(c.arguments||{})):'')).join('').length;
  return {output:Math.ceil(chars/4),estimated:true};
}
export function generationTiming(t){
  if(!t||!Number.isFinite(t.predicted_n)||t.predicted_n<2||!Number.isFinite(t.predicted_ms)||t.predicted_ms<100)return null;
  // llama.cpp excludes the first token in its decoder rate. Use its exact rate
  // when supplied, rather than re-deriving a subtly different number.
  const rate=Number.isFinite(t.predicted_per_second)&&t.predicted_per_second>0?t.predicted_per_second:(t.predicted_n-1)/(t.predicted_ms/1000);
  return {rate,output:t.predicted_n,generationMs:t.predicted_ms};
}
const nativeCount=t=>Number.isFinite(t?.predicted_n)&&t.predicted_n>=0?t.predicted_n:null;
export function completedMetrics(message,wallMs=0,generation={}){
  const durationMs=Math.max(Number(message.durationMs)||0,Number(wallMs)||0);
  const count=outputCount(message);
  const server=generationTiming(generation.timings);
  const span=generation.lastDeltaMs-generation.firstDeltaMs;
  const fallback=!server&&generation.firstDeltaMs!==null&&generation.deltaCount>1&&span>=1000&&count.output>1;
  const exact=nativeCount(generation.timings);
  return {version:3,durationMs:durationMs>0?durationMs:null,...count,...(exact!==null?{output:exact,estimated:false}:{}),thinkingMs:generation.thinkingMs??null,generationMs:server?.generationMs||(fallback?span:null),tokensPerSecond:server?.rate??(fallback?(count.output-1)/(span/1000):null),rateSource:server?'server-generation':fallback?'observed-generation':null,rateEstimated:!server,serverTimings:generation.timings||undefined};
}
export function displayMetrics(message,now){
  const saved=message.replyMetrics||{},count=outputCount(message);
  const durationMs=message.live?Math.max(0,now-(message.turnStartedAt??message.startedAt)):Math.max(Number(saved.durationMs)||0,Number(message.durationMs)||0);
  const server=generationTiming(message.live?message.serverTimings:saved.serverTimings);
  const exact=nativeCount(message.live?message.serverTimings:saved.serverTimings);
  const output=exact??saved.output??count.output,estimated=exact!==null?false:saved.estimated??count.estimated;
  const liveSpan=message.live&&Number.isFinite(message.generationStartedAt)?now-message.generationStartedAt:0;
  // Older saved replies have no decoder timing. Hide their speed rather than
  // presenting request averages or buffered delivery bursts as generation speed.
  const rate=server?.rate??(message.live?(liveSpan>=1000&&output>1?(output-1)/(liveSpan/1000):null):saved.version===3&&saved.rateSource==='observed-generation'?saved.tokensPerSecond:null);
  const rateEstimated=server?false:rate!==null;
  const cost=message.usage?.cost;
  const knownCost=cost&&((Number(cost.total)>0)||cost.totalFromProvider===true);
  let costText='';
  if(knownCost){const total=Number(cost.total)||0;costText=total>0&&total<.000001?'<$0.000001':'$'+total.toFixed(6).replace(/0+$/,'').replace(/\.$/,'.00');if(cost.totalFromProvider!==true)costText+=' est.';}
  return {output,estimated,durationMs:durationMs>0?durationMs:null,rate,rateEstimated,generationMs:server?.generationMs??saved.generationMs,costText};
}
export function elapsedText(ms){if(!Number.isFinite(ms)||ms<=0)return '';if(ms<100)return '<0.1 sec';if(ms<60000)return Math.min(59.9,ms/1000).toFixed(ms<1000?2:1)+' secs';const total=Math.floor(ms/1000),seconds=total%60,minutes=Math.floor(total/60)%60,hours=Math.floor(total/3600);return (hours?hours+' hr ':'')+(minutes+' min ')+seconds+' secs';}
