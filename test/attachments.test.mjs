import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storeAttachment, archiveAttachments } from '../attachments.mjs';

test('verifies originals and saves sanitized per-chat copies',async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'jolt-attachments-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const original=path.join(cwd,'original.txt');await fs.writeFile(original,'hello');
  const base={cwd,chatId:'chat-a',name:'../../bad\\name.txt',type:'text/plain',data:Buffer.from('hello').toString('base64')};
  const good=await storeAttachment({...base,originalPath:original});assert.equal(good.path,original);assert.equal(good.copy,false);
  for(const candidate of [path.join(cwd,'missing'),original]){
    if(candidate===original)await fs.writeFile(original,'longer');
    const result=await storeAttachment({...base,originalPath:candidate});assert.equal(result.copy,true);assert.equal(await fs.readFile(result.path,'utf8'),'hello');assert.ok(!path.basename(result.path).includes('..'));
  }
  await fs.writeFile(original,'HELLO');const changed=await storeAttachment({...base,originalPath:original});assert.equal(changed.copy,true);
  const image=await storeAttachment({...base,name:'',type:'image/png'});assert.match(path.basename(image.path),/pasted-image-\d+\.png$/);
  const other=await storeAttachment({...base,chatId:'chat-b'});
  const trash=path.join(cwd,'trash');await fs.mkdir(trash);await archiveAttachments(cwd,'chat-a',trash);
  assert.equal(await fs.readFile(other.path,'utf8'),'hello');assert.equal(await fs.readFile(path.join(trash,'attachments',path.basename(changed.path)),'utf8'),'hello');
  assert.equal(await fs.readFile(original,'utf8'),'HELLO');
});
