import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, hunks, countChanges } from '../public/diff.mjs';

// Rebuilds both sides from the rows to prove the diff is complete and ordered.
const sides=rows=>({
  before:rows.filter(r=>r.type!=='add').map(r=>r.text),
  after:rows.filter(r=>r.type!=='del').map(r=>r.text)
});

test('produces a minimal, reversible line diff',()=>{
  const before='a\nb\nc\nd\ne\n',after='a\nB\nc\nd\ne\nf\n';
  const rows=diffLines(before,after);
  assert.deepEqual(sides(rows),{before:['a','b','c','d','e'],after:['a','B','c','d','e','f']});
  assert.deepEqual(countChanges(rows),{added:2,removed:1});
  assert.deepEqual(rows.filter(r=>r.type!=='eq').map(r=>[r.type,r.text,r.old,r.new]),[['del','b',2,null],['add','B',null,2],['add','f',null,6]]);
});

test('handles created, deleted and CRLF files',()=>{
  assert.deepEqual(countChanges(diffLines('', 'x\ny\n')),{added:2,removed:0});
  assert.deepEqual(countChanges(diffLines('x\ny\n','')),{added:0,removed:2});
  assert.deepEqual(countChanges(diffLines('x\r\ny\r\n','x\ny\n')),{added:0,removed:0});
});

test('groups distant changes into separate hunks with context',()=>{
  const lines=Array.from({length:40},(_,i)=>'line '+i);
  const changed=[...lines];changed[2]='changed 2';changed[30]='changed 30';
  const result=hunks(diffLines(lines.join('\n'),changed.join('\n')));
  assert.equal(result.length,2);
  assert.equal(result[0].oldStart,1);
  assert.equal(result[1].oldStart,28);
  assert.deepEqual(result.map(h=>h.lines.length),[7,8]);
});

test('falls back to a full replacement for very large rewrites',()=>{
  const before=Array.from({length:3000},(_,i)=>'old '+i).join('\n');
  const after=Array.from({length:3000},(_,i)=>'new '+i).join('\n');
  const rows=diffLines(before,after);
  assert.deepEqual(countChanges(rows),{added:3000,removed:3000});
  assert.deepEqual(sides(rows).after.length,3000);
});
