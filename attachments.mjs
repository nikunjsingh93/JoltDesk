import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function safeAttachmentName(name,type=''){
  const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif'}[type]||'';
  const safe=String(name||'').replace(/[\\/]/g,'_').replace(/\.\./g,'_').replace(/[<>:"|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,120);
  return safe||`pasted-image-${Date.now()}${ext}`;
}
export async function storeAttachment({cwd,chatId,name,type,data,originalPath}){
  const bytes=Buffer.from(data,'base64');
  if(typeof originalPath==='string'&&path.isAbsolute(originalPath)){
    try{const stat=await fs.stat(originalPath);if(stat.isFile()&&stat.size===bytes.length&&digest(await fs.readFile(originalPath))===digest(bytes))return {path:originalPath,copy:false,bytes};}catch{}
  }
  const dir=path.join(cwd,'attachments',chatId);await fs.mkdir(dir,{recursive:true});
  const target=path.join(dir,`${Date.now()}-${randomUUID()}-${safeAttachmentName(name,type)}`);
  await fs.writeFile(target,bytes,{flag:'wx'});return {path:target,copy:true,bytes};
}
export async function archiveAttachments(cwd,chatId,trash){
  const source=path.join(cwd,'attachments',chatId),target=path.join(trash,'attachments');
  try{await fs.cp(source,target,{recursive:true,errorOnExist:true,force:false});await fs.rm(source,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
}
