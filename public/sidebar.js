(()=>{
 const app=document.querySelector('#app'),sidebar=document.querySelector('#admin-sidebar');
 if(!app||!sidebar)return;
 const main=app.querySelector('.sidebar-main'),toggle=document.querySelector('#sidebar-toggle');
 const collapse=document.querySelector('#sidebar-collapse'),close=document.querySelector('#sidebar-close'),overlay=document.querySelector('#sidebar-overlay');
 const mobile=window.matchMedia('(max-width: 760px)');
 const preferenceKey='arena-sidebar-collapsed';
 let collapsed=false,open=false;
 try{collapsed=localStorage.getItem(preferenceKey)==='true';}catch{}
 function render(){
  const drawer=mobile.matches;
  app.dataset.sidebarCollapsed=String(collapsed);app.dataset.sidebarOpen=String(drawer&&open);
  const label=drawer?(open?'Fechar menu':'Abrir menu'):(collapsed?'Expandir menu':'Recolher menu');
  toggle.setAttribute('aria-expanded',String(drawer?open:!collapsed));toggle.setAttribute('aria-label',label);toggle.title=label;
  collapse.setAttribute('aria-expanded',String(!collapsed));collapse.setAttribute('aria-label',collapsed?'Expandir menu':'Recolher menu');collapse.title=collapsed?'Expandir menu':'Recolher menu';
  overlay.hidden=!drawer||!open||app.hidden;
  sidebar.inert=drawer&&!open;main.inert=drawer&&open;
  sidebar.setAttribute('role',drawer?'dialog':'complementary');
  if(drawer&&open)sidebar.setAttribute('aria-modal','true');else sidebar.removeAttribute('aria-modal');
  document.body.classList.toggle('sidebar-scroll-locked',drawer&&open&&!app.hidden);
 }
 function setOpen(next,restore=true){
  const wasOpen=open;
  open=mobile.matches&&next;render();
  if(open)close.focus({preventScroll:true});
  else if(wasOpen&&restore&&!app.hidden)toggle.focus({preventScroll:true});
 }
 function toggleCollapsed(){
  collapsed=!collapsed;
  try{localStorage.setItem(preferenceKey,String(collapsed));}catch{}
  render();
 }
 toggle.addEventListener('click',()=>mobile.matches?setOpen(!open):toggleCollapsed());
 collapse.addEventListener('click',toggleCollapsed);
 close.addEventListener('click',()=>setOpen(false));overlay.addEventListener('click',()=>setOpen(false));
 sidebar.addEventListener('click',event=>{
  if(event.target.closest('[data-view],a[href],#logout'))setOpen(false);
 });
 document.addEventListener('keydown',event=>{
  if(!mobile.matches||!open||app.hidden)return;
  if(event.key==='Escape'){event.preventDefault();setOpen(false);return;}
  if(event.key!=='Tab')return;
  const controls=[...sidebar.querySelectorAll('button:not([disabled]),a[href],[tabindex="0"]')].filter(element=>element.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(!first)return;
  if(!sidebar.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first).focus();}
  else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 });
 mobile.addEventListener('change',()=>{
  const restore=open||mobile.matches&&sidebar.contains(document.activeElement);
  open=false;render();
  if(restore&&!app.hidden)toggle.focus({preventScroll:true});
 });
 window.addEventListener('storage',event=>{
  if(event.key===preferenceKey||event.key===null){collapsed=event.newValue==='true';render();}
 });
 new MutationObserver(()=>{if(app.hidden)open=false;render();}).observe(app,{attributes:true,attributeFilter:['hidden']});
 render();
})();
