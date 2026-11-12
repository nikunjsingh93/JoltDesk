// Agent Skills: folders with a SKILL.md. JoltDesk keeps the engine's own skill
// discovery off and passes the skills the user enabled with --skill.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PROJECT_SKILL_FOLDERS=['.agents/skills','.claude/skills','.pi/skills'];
const NAME=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Reads the YAML frontmatter fields JoltDesk shows. Values are single-line strings or folded blocks.
export function parseSkill(text){
  const match=/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if(!match)return {fields:{},problem:'SKILL.md has no frontmatter.'};
  const fields={};let key=null;
  for(const line of match[1].split(/\r?\n/)){
    const pair=/^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if(pair){key=pair[1];let value=pair[2].trim();if(/^[|>][+-]?$/.test(value))value='';fields[key]=value.replace(/^(["'])(.*)\1$/,'$2');continue;}
    if(key&&/^\s+\S/.test(line))fields[key]=(fields[key]?fields[key]+' ':'')+line.trim();
  }
  const name=fields.name||'',description=fields.description||'';
  let problem=null;
  if(!name)problem='The name field is missing.';
  else if(!NAME.test(name)||name.length>64)problem='The name must use lowercase letters, numbers and single hyphens, up to 64 characters.';
  else if(!description)problem='The description field is missing.';
  else if(description.length>1024)problem='The description is longer than 1024 characters.';
  return {fields,name,description,manual:String(fields['disable-model-invocation']).toLowerCase()==='true',problem};
}

// Finds folders that contain SKILL.md, without descending into a skill once found.
async function skillFolders(root,depth=4){
  const found=[];
  async function walk(dir,level){
    let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
    if(entries.some(e=>e.isFile()&&e.name==='SKILL.md')){found.push(dir);return;}
    if(level>=depth)return;
    for(const entry of entries)if(entry.isDirectory()&&!entry.name.startsWith('.')&&entry.name!=='node_modules')await walk(path.join(dir,entry.name),level+1);
  }
  await walk(root,0);
  return found.sort();
}

async function describe(dir,source,root){
  let text='';
  try{text=await fs.readFile(path.join(dir,'SKILL.md'),'utf8');}catch{return null;}
  const parsed=parseSkill(text);
  return {id:dir,name:parsed.name||path.basename(dir),description:parsed.description,manual:parsed.manual,problem:parsed.problem,source,folder:path.relative(root,dir)||path.basename(dir),file:path.join(dir,'SKILL.md')};
}

export async function projectSkillRoots(projectDir){
  const roots=[];
  for(const folder of PROJECT_SKILL_FOLDERS){
    const root=path.join(projectDir,folder);
    if((await fs.stat(root).catch(()=>null))?.isDirectory())roots.push(root);
  }
  return roots;
}

// Lists personal and project skills and decides which ones a chat loads.
export async function listSkills({personalDir,projectDir,projectEnabled=false,disabled=[]}){
  const off=new Set(disabled),skills=[];
  for(const dir of await skillFolders(personalDir)){const skill=await describe(dir,'personal',personalDir);if(skill)skills.push(skill);}
  if(projectDir)for(const root of await projectSkillRoots(projectDir))
    for(const dir of await skillFolders(root)){const skill=await describe(dir,'project',projectDir);if(skill)skills.push(skill);}
  const seen=new Set();
  for(const skill of skills){
    skill.enabled=!off.has(skill.id);
    const allowed=skill.source==='personal'||projectEnabled;
    // The engine keeps the first skill with a given name, so later duplicates are reported.
    if(!skill.problem&&seen.has(skill.name))skill.problem='Another skill already uses this name.';
    skill.active=allowed&&skill.enabled&&!skill.problem;
    if(skill.active)seen.add(skill.name);
  }
  return {skills,selected:skills.filter(s=>s.active).map(s=>s.id)};
}

export function skillTemplate(name,description){
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g,' ')}\n---\n\n# ${name}\n\nWrite the steps the agent should follow when this skill applies.\n\n- Keep instructions direct and specific.\n- Put long reference material in a references/ folder and mention it here.\n- Put scripts in a scripts/ folder and say when to run them.\n`;
}

export async function createSkill(personalDir,{name,description}){
  name=String(name||'').trim();description=String(description||'').trim();
  if(!NAME.test(name)||name.length>64)throw new Error('Use a skill name with lowercase letters, numbers and single hyphens, such as release-notes.');
  if(!description)throw new Error('Describe what the skill does and when to use it.');
  if(description.length>1024)throw new Error('Keep the description under 1024 characters.');
  const dir=path.join(personalDir,name);
  if(await fs.stat(dir).catch(()=>null))throw new Error(`A skill folder named ${name} already exists.`);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'SKILL.md'),skillTemplate(name,description),{flag:'wx'});
  return dir;
}

// Copies a skill folder (one that contains SKILL.md) into the personal skills folder.
export async function importSkill(personalDir,source){
  source=path.resolve(String(source||''));
  const text=await fs.readFile(path.join(source,'SKILL.md'),'utf8').catch(()=>null);
  if(text===null)throw new Error('Choose a folder that contains a SKILL.md file.');
  const parsed=parseSkill(text);
  const name=parsed.name&&!parsed.problem?parsed.name:path.basename(source).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'skill';
  const target=path.join(personalDir,name);
  if(path.resolve(source)===path.resolve(target))throw new Error('This skill is already in your skills folder.');
  if(await fs.stat(target).catch(()=>null))throw new Error(`A skill folder named ${name} already exists.`);
  await fs.mkdir(personalDir,{recursive:true});
  await fs.cp(source,target,{recursive:true,errorOnExist:true,force:false,filter:file=>!/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(path.relative(source,file))});
  return target;
}

// Moves a personal skill to the trash folder instead of deleting it.
export async function removeSkill(personalDir,dir,trashDir){
  const relative=path.relative(personalDir,dir);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Only personal skills can be removed here.');
  await fs.mkdir(trashDir,{recursive:true});
  await fs.rename(dir,path.join(trashDir,path.basename(dir)+'-'+Date.now()));
}
