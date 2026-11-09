import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { desktopDataDir } from '../desktop-profile.cjs';

test('JoltDesk reuses existing Bolt Desktop data and keeps explicit overrides',async()=>{
  await fs.mkdir('work',{recursive:true});
  const appData=path.resolve(await fs.mkdtemp('work/profile-rename-'));
  const current=path.join(appData,'joltdesk');
  const legacy=path.join(appData,'bolt-desktop');
  assert.equal(desktopDataDir(appData),current);
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy,'workspace.json'),'{"chats":[]}');
  assert.equal(desktopDataDir(appData),legacy);
  assert.equal(desktopDataDir(appData,'work/isolated-profile'),path.resolve('work/isolated-profile'));
  await fs.mkdir(current);
  await fs.mkdir(path.join(current,'sessions'));
  assert.equal(desktopDataDir(appData),current);
});
