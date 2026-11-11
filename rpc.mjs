import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function findBinary(override) {
  const candidates = [override, process.env.PI_BOLT_PATH,
    path.join(homedir(), '.pi-bolt', `pi-bolt-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi-bolt.exe' : 'pi-bolt'),
    process.platform === 'win32' ? path.join(homedir(), '.pi-bolt', 'pi-bolt-win32-x64', 'pi-bolt.exe') : undefined,
    path.join(homedir(), '.local', 'bin', 'pi-bolt')];
  return candidates.find(p => p && existsSync(p)) || 'pi-bolt';
}

export class Rpc extends EventEmitter {
  constructor({binary, cwd, agentDir, sessionDir, sessionId, key, mode='chat', extension,serverTimings=false,autoOutput=false,webAccess}) {
    super(); this.pending = new Map(); this.buffer = ''; this.diagnostics = ''; this.closed = false;
    const args = ['--mode','rpc','--no-extensions','--no-skills','--no-prompt-templates','--no-mcp',
      '--session-dir',sessionDir,'--session-id',sessionId];
    if(extension){
      const tools=['read','write','edit','bash'];
      if(process.platform==='win32')tools.push('powershell');
      tools.push('grep','find','ls');
      if(webAccess)tools.push('web_search','browse_page');
      if(webAccess?.browser)tools.push('browser_open','browser_read');
      args.push('--tools',tools.join(','));
    }
    else if(mode === 'chat') args.push('--no-tools');
    else if(mode === 'read') args.push('--tools','read,grep,find,ls');
    else args.push('--tools',process.platform === 'win32' ? 'read,write,edit,bash,powershell,grep,find,ls' : 'read,write,edit,bash,grep,find,ls');
    if(extension) args.push('-e', extension);
    this.child = spawn(binary,args,{cwd,windowsHide:true,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,
      OPENAI_API_KEY:key || 'discovery-only-no-api-key', BOLT_LOCAL_API_KEY:key||'local-no-key', BOLT_PERMISSION_MODE:mode, BOLT_LLAMA_TIMINGS:serverTimings?'1':'0', BOLT_AUTO_OUTPUT:autoOutput?'1':'0', BOLT_WEB_URL:webAccess?.url||'', BOLT_WEB_KEY:webAccess?.key||'', BOLT_BROWSER:webAccess?.browser?'1':'0', PI_OFFLINE:'1', PI_TELEMETRY:'0'}});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let n;
      while((n=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,n).replace(/\r$/,''); this.buffer=this.buffer.slice(n+1);
        if(!line) continue;
        try {
          const event=JSON.parse(line);
          if(event.type === 'response' && this.pending.has(event.id)) {
            const p=this.pending.get(event.id); this.pending.delete(event.id); clearTimeout(p.timer);
            event.success ? p.resolve(event.data) : p.reject(new Error(event.error || 'RPC command failed'));
          } else this.emit('event',event);
        } catch(error) {this.emit('diagnostic',error.message);}
      }
    });
    this.child.stderr.on('data',d=>{this.diagnostics=(this.diagnostics+d.toString()).slice(-4000);});
    this.child.on('error',e=>this.fail(new Error(`Cannot start Pi-Bolt: ${e.message}. Install Pi-Bolt or choose its executable in Settings.`)));
    this.child.on('exit',(code)=>this.fail(new Error(`Pi-Bolt exited (${code}). ${this.diagnostics}`)));
  }
  fail(error) {this.closed=true; for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);} this.pending.clear(); this.emit('closed',error.message);}
  send(record) {if(this.closed) throw new Error('Pi-Bolt is not running'); this.child.stdin.write(JSON.stringify(record)+'\n');}
  command(type,data={},timeout=25000) {
    if(this.closed) return Promise.reject(new Error('Pi-Bolt is not running'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${type} timed out. ${this.diagnostics}`));},timeout);
      this.pending.set(id,{resolve,reject,timer});this.send({id,type,...data});});
  }
  close() {if(!this.closed){this.child.stdin.end(); const timer=setTimeout(()=>this.child.kill(),1500);timer.unref();}}
}
