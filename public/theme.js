// Apply the preference before CSS paints; page access does not depend on storage.
(()=>{
 const root=document.documentElement;
 const preferenceKey='arena-theme';
 const valid=value=>value==='light'||value==='dark';
 const system=window.matchMedia?.('(prefers-color-scheme: dark)');
 let preference=null;
 try{const saved=localStorage.getItem(preferenceKey);if(valid(saved))preference=saved;}catch{}
 function updateControls(){
  const dark=root.dataset.theme==='dark';
  for(const button of document.querySelectorAll('[data-theme-toggle]')){
   const label=dark?'Ativar tema claro':'Ativar tema escuro';
   button.setAttribute('aria-pressed',String(dark));
   button.setAttribute('aria-label',label);button.title=label;
   const icon=button.querySelector('[data-theme-icon]');if(icon)icon.textContent=dark?'☀':'☾';
   const text=button.querySelector('[data-theme-label]');if(text)text.textContent=dark?'Tema claro':'Tema escuro';
  }
 }
 function apply(){
  const theme=preference||(system?.matches?'dark':'light');
  root.dataset.theme=theme;root.style.colorScheme=theme;
  const color=document.querySelector('meta[name="theme-color"]');
  if(color)color.content=theme==='dark'?'#101d18':'#f7f8f4';
  updateControls();
 }
 apply();
 document.addEventListener('DOMContentLoaded',updateControls,{once:true});
 document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-theme-toggle]');if(!button||button.disabled)return;
  preference=root.dataset.theme==='dark'?'light':'dark';apply();
  try{localStorage.setItem(preferenceKey,preference);}catch{}
 });
 const followSystem=()=>{if(!preference)apply();};
 if(system?.addEventListener)system.addEventListener('change',followSystem);
 else system?.addListener?.(followSystem);
 window.addEventListener('storage',event=>{
  if(event.key!==preferenceKey&&event.key!==null)return;
  preference=valid(event.newValue)?event.newValue:null;apply();
 });
})();
