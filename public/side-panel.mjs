// Tabs of the right side panel: Files, Changes and Browser share one panel.
const MODES=['files','changes','git','terminal','browser'];
const store={get(key){try{return localStorage.getItem(key);}catch{return null;}},set(key,value){try{localStorage.setItem(key,value);}catch{}}};
let available=new Set(['files','changes','git','terminal']);

export function panelMode(){return document.body.dataset.panel||'files';}

export function setPanelMode(mode){
  if(!available.has(mode))mode='files';
  document.body.dataset.panel=mode;
  for(const name of MODES){
    document.body.classList.toggle('panel-'+name,name===mode);
    document.querySelector(`[data-panel-tab="${name}"]`)?.setAttribute('aria-selected',String(name===mode));
    const view=document.querySelector(`[data-panel-view="${name}"]`);
    if(view)view.hidden=name!==mode;
  }
  store.set('joltdesk-panel-mode',mode);
  window.dispatchEvent(new CustomEvent('panelmodechange',{detail:mode}));
}

export function initSidePanel({browser}){
  if(browser)available.add('browser');
  for(const tab of document.querySelectorAll('[data-panel-tab]')){
    tab.hidden=!available.has(tab.dataset.panelTab);
    tab.onclick=()=>setPanelMode(tab.dataset.panelTab);
  }
  setPanelMode(store.get('joltdesk-panel-mode')||'files');
}
