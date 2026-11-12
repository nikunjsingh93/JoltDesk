import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSkill, listSkills, createSkill, importSkill, removeSkill } from '../skills.mjs';

const root=()=>path.resolve('work','skills-'+Date.now()+'-'+Math.random().toString(16).slice(2));
async function write(dir,text){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'SKILL.md'),text);}
const skill=(name,description='Does a thing. Use when needed.',extra='')=>`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody\n`;

test('parses frontmatter and reports invalid skills',()=>{
  const ok=parseSkill('---\nname: pdf-tools\ndescription: >\n  Extract text from PDFs.\n  Use for PDFs.\ndisable-model-invocation: true\n---\nBody');
  assert.deepEqual({name:ok.name,description:ok.description,manual:ok.manual,problem:ok.problem},{name:'pdf-tools',description:'Extract text from PDFs. Use for PDFs.',manual:true,problem:null});
  assert.match(parseSkill('no frontmatter').problem,/frontmatter/);
  assert.match(parseSkill('---\nname: Bad Name\ndescription: x\n---\n').problem,/lowercase/);
  assert.match(parseSkill('---\nname: ok\n---\n').problem,/description/);
  assert.equal(parseSkill('---\nname: "quoted-name"\ndescription: \'Quoted.\'\n---\n').name,'quoted-name');
});

test('lists personal and opt-in project skills and selects the active ones',async()=>{
  const dir=root(),personal=path.join(dir,'personal'),project=path.join(dir,'project');
  await write(path.join(personal,'release-notes'),skill('release-notes'));
  await write(path.join(personal,'group','nested-skill'),skill('nested-skill'));
  await write(path.join(personal,'broken'),'---\nname: broken\n---\n');
  await write(path.join(project,'.agents','skills','deploy'),skill('deploy'));
  await write(path.join(project,'.claude','skills','release-notes'),skill('release-notes'));
  await fs.mkdir(path.join(project,'.agents','skills','node_modules','x'),{recursive:true});

  let result=await listSkills({personalDir:personal,projectDir:project});
  assert.deepEqual(result.skills.map(s=>[s.name,s.source,s.active]),[
    ['broken','personal',false],['nested-skill','personal',true],['release-notes','personal',true],
    ['deploy','project',false],['release-notes','project',false]
  ]);
  assert.deepEqual(result.selected,[path.join(personal,'group','nested-skill'),path.join(personal,'release-notes')]);
  assert.equal(result.skills.find(s=>s.name==='deploy').folder,path.join('.agents','skills','deploy'));

  result=await listSkills({personalDir:personal,projectDir:project,projectEnabled:true,disabled:[path.join(personal,'group','nested-skill')]});
  assert.deepEqual(result.selected,[path.join(personal,'release-notes'),path.join(project,'.agents','skills','deploy')]);
  assert.match(result.skills.find(s=>s.source==='project'&&s.name==='release-notes').problem,/already uses this name/);
});

test('creates, imports and removes personal skills',async()=>{
  const dir=root(),personal=path.join(dir,'personal'),outside=path.join(dir,'download','Fancy Skill');
  const created=await createSkill(personal,{name:'commit-style',description:'Write commit messages. Use for commits.'});
  assert.match(await fs.readFile(path.join(created,'SKILL.md'),'utf8'),/name: commit-style\ndescription: Write commit messages/);
  await assert.rejects(createSkill(personal,{name:'commit-style',description:'Again.'}),/already exists/);
  await assert.rejects(createSkill(personal,{name:'Bad name',description:'x'}),/lowercase/);

  await write(outside,skill('fancy-skill'));
  await fs.mkdir(path.join(outside,'scripts'));await fs.writeFile(path.join(outside,'scripts','run.sh'),'echo hi\n');
  await fs.mkdir(path.join(outside,'node_modules','dep'),{recursive:true});
  const imported=await importSkill(personal,outside);
  assert.equal(imported,path.join(personal,'fancy-skill'));
  assert.equal(await fs.readFile(path.join(imported,'scripts','run.sh'),'utf8'),'echo hi\n');
  await assert.rejects(fs.stat(path.join(imported,'node_modules')));
  await assert.rejects(importSkill(personal,outside),/already exists/);
  await assert.rejects(importSkill(personal,path.join(dir,'download')),/SKILL.md/);

  await removeSkill(personal,imported,path.join(dir,'trash'));
  await assert.rejects(fs.stat(imported));
  assert.equal((await fs.readdir(path.join(dir,'trash'))).length,1);
  await assert.rejects(removeSkill(personal,outside,path.join(dir,'trash')),/Only personal skills/);
});
