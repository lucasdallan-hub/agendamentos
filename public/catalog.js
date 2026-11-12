const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);
const dateLabel=date=>new Date(date+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
const key=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
let catalog,selection,requestKey;
async function api(path,body){const response=await fetch('/api/public/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(result.error||'Não foi possível concluir. Tente novamente.');return result;}
async function search(){
 $('#catalog-error').textContent='';$('#catalog-message').textContent='Buscando quadras e horários…';$('#catalog-courts').replaceChildren();
 try{
  catalog=await api(`catalog?date=${encodeURIComponent($('#catalog-date').value)}&duration=${$('#catalog-duration').value}`);
  $('#catalog-message').textContent=catalog.courts.length?'Escolha um horário disponível. O valor exibido corresponde ao tempo de jogo selecionado.':'Nenhuma quadra disponível para agendamento online.';
  $('#catalog-courts').innerHTML=catalog.courts.map(c=>`<article class="catalog-court"><div class="court-visual"><div class="court-lines"><div></div></div></div><div class="court-info"><span class="eyebrow">${esc(c.type)}</span><h2>${esc(c.name)}</h2><p>${money(c.price)} / hora</p><div class="catalog-slots">${c.slots.length?c.slots.map((s,i)=>`<button class="catalog-slot" data-court="${c.id}" data-slot="${i}"><strong>${s.start} – ${s.end}</strong><span>${money(s.total)}</span></button>`).join(''):'<p>Sem horários livres nesta data e duração. Tente outra data.</p>'}</div></div></article>`).join('');
 }catch(error){$('#catalog-message').textContent='';$('#catalog-error').textContent=error.message;}
}
$('#catalog-filter').onsubmit=e=>{e.preventDefault();search();};
$('#catalog-courts').onclick=e=>{
 const button=e.target.closest('[data-court]');if(!button)return;
 const court=catalog.courts.find(c=>c.id===Number(button.dataset.court));
 selection={court_id:court.id,date:catalog.date,...court.slots[Number(button.dataset.slot)]};requestKey=key();
 $('#catalog-selection').textContent=`${court.name} · ${dateLabel(selection.date)} · ${selection.start} – ${selection.end} · ${money(selection.total)}`;
 $('#catalog-booking-error').textContent='';$('#catalog-modal').showModal();
};
$('#catalog-close').onclick=()=>$('#catalog-modal').close();
$('#catalog-booking-form').onsubmit=async e=>{
 e.preventDefault();$('#catalog-submit').disabled=true;$('#catalog-booking-error').textContent='';
 try{
  const fields=Object.fromEntries(new FormData(e.target));
  const result=await api('bookings',{court_id:selection.court_id,date:selection.date,start:selection.start,end:selection.end,...fields,request_key:requestKey});
  $('#catalog-modal').close();location.hash=result.token;await showConfirmation(result.token);
 }catch(error){$('#catalog-booking-error').textContent=error.message;await search();}
 finally{$('#catalog-submit').disabled=false;}
};
async function showConfirmation(token){
 $('#catalog-error').textContent='';$('#catalog-search').hidden=true;$('#catalog-confirmation').hidden=false;
 try{
  const b=await api('bookings/'+token);
  $('#catalog-confirmation').innerHTML=`<span class="eyebrow">${b.status==='cancelled'?'RESERVA CANCELADA':'HORÁRIO RESERVADO'}</span><h2>${b.status==='cancelled'?'Entre em contato com a arena.':`Tudo certo, ${esc(b.customer)}!`}</h2><p>${esc(b.court_name)} · ${dateLabel(b.date)} · ${b.start} – ${b.end}</p><p class="catalog-total">${money(b.total)}</p><p>${b.paid?'Pagamento confirmado.':b.status==='cancelled'?'Esta reserva foi cancelada pela arena.':'Reserva confirmada. O pagamento ainda está pendente.'}</p>${!b.paid&&b.status==='confirmed'?`<div class="catalog-payment-actions">${b.pix_ready?'<button class="primary" data-payment="pix">Pagar com Pix</button>':''}${b.checkout_ready?'<button class="outline" data-payment="checkout">Pagar pelo Mercado Pago</button>':''}</div>${!b.pix_ready&&!b.checkout_ready?'<p>Entre em contato com a arena para combinar o pagamento.</p>':''}`:''}<p>Guarde este link privado para consultar sua reserva. Não o compartilhe com terceiros.</p><button id="copy-reservation" class="outline">Copiar link da reserva</button> <a class="outline" href="/catalogo">Fazer outra reserva</a>`;
  $('#copy-reservation').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$('#copy-reservation').textContent='Link copiado';}catch{$('#catalog-error').textContent='Copie o endereço desta página para guardar seu link.';}};
 }catch(error){$('#catalog-confirmation').textContent='Não foi possível consultar a reserva.';$('#catalog-error').textContent=error.message;}
}
$('#catalog-confirmation').onclick=async e=>{
 const button=e.target.closest('[data-payment]');if(!button)return;
 button.disabled=true;$('#catalog-error').textContent='';
 try{const result=await api(`bookings/${location.hash.slice(1)}/${button.dataset.payment}`,{});location.assign(result.path||result.checkout_url);}
 catch(error){$('#catalog-error').textContent=error.message;button.disabled=false;}
};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('#catalog-date').min=today;$('#catalog-date').value=today;
const last=new Date(today+'T12:00:00Z');last.setUTCDate(last.getUTCDate()+180);$('#catalog-date').max=last.toISOString().slice(0,10);
if(location.hash)showConfirmation(location.hash.slice(1));else search();
