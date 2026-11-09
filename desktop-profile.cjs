const {existsSync}=require('node:fs');
const path=require('node:path');

function desktopDataDir(appData,override){
  if(override)return path.resolve(override);

  const current=path.join(appData,'joltdesk');
  const directories=[current,path.join(appData,'bolt-desktop'),path.join(appData,'Bolt Desktop')];
  const profileFiles=['workspace.json','credential.bin','sessions'];
  return directories.find(dir=>profileFiles.some(file=>existsSync(path.join(dir,file))))||current;
}

module.exports={desktopDataDir};
