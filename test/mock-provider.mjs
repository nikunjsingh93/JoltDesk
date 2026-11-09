import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
export async function mockProvider(){
  const defaultAnswer='Here is a working example:\n\n```javascript\nconst greeting = "Hello, Bolt";\nconsole.log(greeting);\n```\n\nYour workspace is ready.';
  let answer=defaultAnswer;
  const requests=[];let nextTool=null,delay=8,thoughtText='I will check the request and explain the result clearly.',headerDelay=0,buffered=false,fragmentTools=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');requests.push(body);
    if(headerDelay)await new Promise(r=>setTimeout(r,headerDelay));
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const pending=[];let sequence_number=0;const send=(type,data)=>{const frame=`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence_number++,...data})}\n\n`;if(buffered)pending.push(frame);else res.write(frame);};
    const id='resp_'+randomUUID(),rid='rs_'+randomUUID(),mid='msg_'+randomUUID();
    const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:'bolt-test',output:[],error:null};
    send('response.created',{response});
    if(nextTool){
      const tool=nextTool;nextTool=null;
      const item={type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool.name,arguments:'',status:'in_progress'};
      send('response.output_item.added',{output_index:0,item});
      const args=JSON.stringify(tool.args);for(const delta of fragmentTools?args.match(/[\s\S]{1,24}/g):[args]){send('response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta});if(fragmentTools)await new Promise(r=>setTimeout(r,delay));}
      item.arguments=JSON.stringify(tool.args);item.status='completed';
      send('response.function_call_arguments.done',{output_index:0,item_id:item.id,arguments:item.arguments});
      send('response.output_item.done',{output_index:0,item});response.output.push(item);
    }else{
      const reasoning={type:'reasoning',id:rid,summary:[]};send('response.output_item.added',{output_index:0,item:reasoning});
      send('response.reasoning_summary_part.added',{item_id:rid,output_index:0,summary_index:0,part:{type:'summary_text',text:''}});
      const thought=thoughtText;
      for(const delta of thought.match(/[\s\S]{1,12}/g)){send('response.reasoning_summary_text.delta',{item_id:rid,output_index:0,summary_index:0,delta});await new Promise(r=>setTimeout(r,delay));}
      send('response.reasoning_summary_text.done',{item_id:rid,output_index:0,summary_index:0,text:thought});
      reasoning.summary=[{type:'summary_text',text:thought}];send('response.output_item.done',{output_index:0,item:reasoning});response.output.push(reasoning);
      const item={type:'message',role:'assistant',id:mid,status:'in_progress',content:[]};send('response.output_item.added',{output_index:1,item});
      send('response.content_part.added',{item_id:mid,output_index:1,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
      const text=answer;
      for(const delta of text.match(/[\s\S]{1,10}/g)){send('response.output_text.delta',{item_id:mid,output_index:1,content_index:0,delta});await new Promise(r=>setTimeout(r,delay));}
      send('response.output_text.done',{item_id:mid,output_index:1,content_index:0,text});item.status='completed';item.content=[{type:'output_text',text,annotations:[]}];
      send('response.content_part.done',{item_id:mid,output_index:1,content_index:0,part:item.content[0]});send('response.output_item.done',{output_index:1,item});response.output.push(item);
    }
    response.status='completed';response.usage={input_tokens:120,output_tokens:42,total_tokens:162,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:12}};
    send('response.completed',{response});res.end(buffered?pending.join(''):undefined);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,tool:(name,args)=>{nextTool={name,args};},setThought:t=>{thoughtText=t;},setAnswer:(value=defaultAnswer)=>{answer=value;},setDelay:d=>{delay=d;},setHeaderDelay:d=>{headerDelay=d;},setBuffered:v=>{buffered=v;},setFragmentTools:v=>{fragmentTools=v;},close:()=>server.close()};
}
export const testModel={id:'bolt-test',name:'Bolt Test Model',api:'openai-responses',reasoning:true,input:['text','image'],contextWindow:32000,maxTokens:4096,cost:{input:1,output:2,cacheRead:.1,cacheWrite:0}};
