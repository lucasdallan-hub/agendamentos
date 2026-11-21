const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);
const dateLabel=date=>new Date(date+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
const key=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
let catalog,selection,requestKey,reservationView,misticpayBusy=false;
let paymentCheck,paymentTimer,pageSuspended=false;
async function api(path,body,signal){
 const response=await fetch('/api/public/'+path,{
  method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},
  body:body?JSON.stringify(body):undefined,cache:'no-store',signal
 });
 const result=await response.json().catch(()=>null);
 if(!response.ok||result===null){
  const message=typeof result?.error==='string'?result.error:'Não foi possível concluir. Tente novamente.';
  throw Object.assign(new Error(message),{status:response.status});
 }
 return result;
}
const courtArt='<div class="court-lines" aria-hidden="true"><div></div></div>';
function courtPhotos(court){
 return (Array.isArray(court.photos)?court.photos:[]).filter(photo=>
  typeof photo?.id==='string'&&/^[a-f0-9]{32}$/.test(photo.id)&&photo.url===`/api/public/courts/${court.id}/photos/${photo.id}`
 );
}
const courtPhotoLabel=(court,index)=>`Foto ${index+1} da quadra ${court.name}`;
function courtVisual(court){
 const photos=courtPhotos(court);
 if(!photos.length)return `<div class="court-visual">${courtArt}</div>`;
 return `<div class="court-visual catalog-photo-gallery" data-photo-court="${esc(court.id)}" data-photo-index="0" role="group" aria-label="Fotos da quadra ${esc(court.name)}">
  ${courtArt}
  <img class="catalog-court-photo" src="${esc(photos[0].url)}" alt="${esc(courtPhotoLabel(court,0))}" loading="lazy" decoding="async">
  ${photos.length>1?`<div class="catalog-photo-controls">
   <button type="button" data-photo-step="-1" aria-label="Foto anterior">‹</button>
   <span class="catalog-photo-count" role="status">1 de ${photos.length}</span>
   <button type="button" data-photo-step="1" aria-label="Próxima foto">›</button>
  </div>`:''}
 </div>`;
}
function changeCourtPhoto(button){
 const gallery=button.closest('.catalog-photo-gallery');
 const court=catalog.courts.find(c=>c.id===Number(gallery.dataset.photoCourt));
 const photos=courtPhotos(court);
 const index=(Number(gallery.dataset.photoIndex)+Number(button.dataset.photoStep)+photos.length)%photos.length;
 const image=gallery.querySelector('img');
 gallery.dataset.photoIndex=index;
 image.alt=courtPhotoLabel(court,index);
 image.src=photos[index].url;
 image.hidden=false;
 gallery.querySelector('.catalog-photo-count').textContent=`${index+1} de ${photos.length}`;
}
async function search(){
 $('#catalog-error').textContent='';$('#catalog-message').textContent='Buscando quadras e horários…';$('#catalog-courts').replaceChildren();
 try{
  catalog=await api(`catalog?date=${encodeURIComponent($('#catalog-date').value)}&duration=${$('#catalog-duration').value}`);
  $('#catalog-message').textContent=catalog.courts.length?'Escolha um horário disponível. O valor exibido corresponde ao tempo de jogo selecionado.':'Nenhuma quadra disponível para agendamento online.';
  $('#catalog-courts').innerHTML=catalog.courts.map(c=>`<article class="catalog-court">${courtVisual(c)}<div class="court-info"><span class="eyebrow">${esc(c.type)}</span><h2>${esc(c.name)}</h2><p>${money(c.price)} / hora</p><div class="catalog-slots">${c.slots.length?c.slots.map((s,i)=>`<button class="catalog-slot" data-court="${c.id}" data-slot="${i}"><strong>${s.start} – ${s.end}</strong><span>${money(s.total)}</span></button>`).join(''):'<p>Sem horários livres nesta data e duração. Tente outra data.</p>'}</div></div></article>`).join('');
 }catch(error){$('#catalog-message').textContent='';$('#catalog-error').textContent=error.message;}
}
$('#catalog-filter').onsubmit=e=>{e.preventDefault();search();};
$('#catalog-courts').addEventListener('error',e=>{
 if(e.target.matches('.catalog-court-photo'))e.target.hidden=true;
},true);
$('#catalog-courts').onclick=e=>{
 const photoButton=e.target.closest('[data-photo-step]');
 if(photoButton){changeCourtPhoto(photoButton);return;}
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
  $('#catalog-modal').close();location.hash=result.token;
 }catch(error){$('#catalog-booking-error').textContent=error.message;await search();}
 finally{$('#catalog-submit').disabled=false;}
};
const paymentLabels={pix:'Pix',credit_card:'Cartão de crédito',debit_card:'Cartão de débito'};
const misticpayStatus={
 pending:'Aguardando o pagamento do Pix.',
 approved:'Pagamento confirmado.',
 failed:'A cobrança não foi concluída. Fale com a arena para combinar o pagamento.',
 review:'A arena está conferindo o pagamento.',
 cancelled:'A cobrança Pix foi cancelada.',
 refunded:'O pagamento Pix foi devolvido.',
 creating:'A cobrança está sendo preparada.',
 unknown:'A confirmação da cobrança está pendente.',
 archived:'Cobrança registrada no histórico da arena.'
};
function misticpayDetails(payment,canAct){
 const pending=canAct&&payment.status==='pending';
 const qr=payment.qr_code;
 const qrImage=pending&&typeof qr==='string'&&qr.length<=200_000&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(qr)
  ?`<img class="misticpay-qr" src="${esc(qr)}" alt="QR Code do Pix via MisticPay">`:'';
 const code=pending&&typeof payment.copy_paste==='string'&&payment.copy_paste.length<=4096
  ?payment.copy_paste:'';
 const canCheck=canAct&&['pending','review','creating','unknown'].includes(payment.status);
 return `<section class="misticpay-details" aria-labelledby="misticpay-title">
  <h3 id="misticpay-title">Pix via MisticPay</h3>
  <p>${misticpayStatus[payment.status]||'Consulte a arena sobre este pagamento.'}</p>
  ${qrImage}
  ${code?`<label>Pix copia e cola<input id="misticpay-copy-code" readonly value="${esc(code)}"></label>`:''}
  ${code||canCheck?`<div class="catalog-payment-actions">
   ${code?'<button type="button" class="primary" data-misticpay-copy>Copiar código Pix</button>':''}
   ${canCheck?'<button type="button" class="outline" data-payment="misticpay/check">Verificar pagamento</button>':''}
  </div>`:''}
 </section>`;
}
function paymentChoices(booking){
 if(booking.misticpay)return misticpayDetails(booking.misticpay,!booking.paid&&booking.status==='confirmed');
 if(booking.paid||booking.status!=='confirmed')return '';
 if(booking.checkout_link_ready&&!booking.checkout_method){
  return '<div class="catalog-payment-actions"><button type="button" class="primary" data-payment="checkout">Continuar pagamento</button></div>';
 }
 const directPix=!booking.checkout_method&&booking.pix_ready;
 const methods=booking.checkout_ready
  ? Object.keys(paymentLabels).filter(method=>!booking.checkout_method||booking.checkout_method===method)
  : [];
 if(directPix&&!methods.includes('pix'))methods.unshift('pix');
 const misticpayReady=booking.misticpay_ready&&!booking.checkout_method;
 if(!methods.length&&!misticpayReady)return '<p>Entre em contato com a arena para combinar o pagamento.</p>';
 const buttons=methods.map(method=>{
  const route=method==='pix'&&directPix?'pix':'checkout';
  const label=method==='pix'&&misticpayReady?(directPix?'Pix direto':'Pix pelo Mercado Pago'):paymentLabels[method];
  return `<button type="button" class="${method==='pix'?'primary':'outline'}" data-payment="${route}" data-method="${method}">${label}</button>`;
 }).join('');
 const misticpayButton=misticpayReady?'<button type="button" class="outline" data-payment="misticpay">Pix via MisticPay</button>':'';
 const debitNote=methods.includes('debit_card')?'<p>A disponibilidade do cartão de débito depende das opções exibidas pelo Mercado Pago no checkout.</p>':'';
 return `<h3>Forma de pagamento</h3><div class="catalog-payment-actions">${buttons}${misticpayButton}</div>${debitNote}`;
}
function renderConfirmation(view,b){
 view.booking=b;
 const summary=b.status==='cancelled'?'Esta reserva foi cancelada pela arena.':b.misticpay?'':b.paid?'Pagamento confirmado.':'Reserva confirmada. O pagamento ainda está pendente.';
 $('#catalog-confirmation').innerHTML=`<span class="eyebrow">${b.status==='cancelled'?'RESERVA CANCELADA':'HORÁRIO RESERVADO'}</span><h2>${b.status==='cancelled'?'Entre em contato com a arena.':`Tudo certo, ${esc(b.customer)}!`}</h2><p>${esc(b.court_name)} · ${dateLabel(b.date)} · ${b.start} – ${b.end}</p><p class="catalog-total">${money(b.total)}</p>${summary?`<p>${summary}</p>`:''}${paymentChoices(b)}<p>Guarde este link privado para consultar sua reserva. Não o compartilhe com terceiros.</p><button id="copy-reservation" class="outline">Copiar link da reserva</button> <a class="outline" href="/catalogo">Fazer outra reserva</a>`;
 $('#copy-reservation').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$('#copy-reservation').textContent='Link copiado';}catch{$('#catalog-error').textContent='Copie o endereço desta página para guardar seu link.';}};
 schedulePaymentCheck();
}
const currentToken=()=>location.hash.slice(1);
const isCurrentReservation=view=>view&&view===reservationView&&view.token===currentToken()&&!pageSuspended;
async function showConfirmation(token){
 const view={token};
 reservationView=view;
 $('#catalog-error').textContent='';$('#catalog-search').hidden=true;$('#catalog-confirmation').hidden=false;
 $('#catalog-confirmation').textContent='Carregando reserva…';
 try{
  if(!/^[a-f0-9]{64}$/.test(token))throw Error('Link de reserva inválido.');
  const booking=await api('bookings/'+token);
  if(isCurrentReservation(view))renderConfirmation(view,booking);
 }catch(error){
  if(!isCurrentReservation(view))return;
  $('#catalog-confirmation').textContent='Não foi possível consultar a reserva.';
  $('#catalog-error').textContent=error.message;
 }
}
function updateMisticpay(view,payment){
 const booking=view.booking;
 if(booking.paid&&automaticPaymentStates.includes(payment.status))return;
 const reversed=['refunded','review','cancelled'].includes(payment.status);
 const paid=!reversed&&(booking.paid||payment.status==='approved');
 if(paid===booking.paid&&booking.misticpay?.status===payment.status&&
    booking.misticpay?.qr_code===payment.qr_code&&booking.misticpay?.copy_paste===payment.copy_paste)return;
 $('#catalog-error').textContent='';
 renderConfirmation(view,{...booking,paid,misticpay:payment});
}
const automaticPaymentStates=['pending','creating','unknown'];
const paymentStatusInterval=2_000,providerCheckInterval=15_000;
function canCheckMisticpay(view,manual=false){
 const booking=view?.booking;
 const status=booking?.misticpay?.status;
 const pending=automaticPaymentStates.includes(status);
 const eligible=manual?pending||status==='review':pending&&!view?.stopPolling;
 return eligible&&isCurrentReservation(view)&&!document.hidden&&booking?.status==='confirmed'&&!booking.paid;
}
function schedulePaymentCheck(){
 clearTimeout(paymentTimer);
 const view=reservationView;
 if(paymentCheck||!canCheckMisticpay(view))return;
 view.nextProviderCheck??=Date.now()+providerCheckInterval;
 paymentTimer=setTimeout(()=>checkMisticpay(view),paymentStatusInterval);
}
async function checkMisticpay(view,manual=false){
 if(paymentCheck||!canCheckMisticpay(view,manual))return;
 clearTimeout(paymentTimer);
 const check=new AbortController();
 paymentCheck=check;
 const active=()=>isCurrentReservation(view)&&!check.signal.aborted;
 const button=$('#catalog-confirmation [data-payment="misticpay/check"]');
 if(button)button.disabled=true;
 if(manual)$('#catalog-error').textContent='';
 try{
  const path=`bookings/${view.token}`;
  if(!manual){
   const {status}=await api(path+'/misticpay',undefined,check.signal);
   if(!active())return;
   const previousStatus=view.booking.misticpay.status;
   if(status==='pending'&&previousStatus!=='pending'){
    const booking=await api(path,undefined,check.signal);
    if(active()&&!view.booking.paid)renderConfirmation(view,booking);
   }else if(status!==previousStatus){
    updateMisticpay(view,{status,qr_code:null,copy_paste:null});
   }
  }
  const now=Date.now();
  if(active()&&canCheckMisticpay(view,manual)&&(manual||now>=view.nextProviderCheck)){
   view.nextProviderCheck=now+providerCheckInterval;
   const payment=await api(path+'/misticpay/check',{},check.signal);
   if(active())updateMisticpay(view,payment);
  }
 }catch(error){
  if(active()){
   if([401,403,404,410].includes(error.status))view.stopPolling=true;
   if(manual)$('#catalog-error').textContent=error.message;
  }
 }finally{
  paymentCheck=null;
  if(button)button.disabled=false;
  schedulePaymentCheck();
 }
}
const misticpayDialog=$('#catalog-misticpay-modal');
const cpfField=$('#catalog-misticpay-cpf');
$('#catalog-misticpay-close').onclick=()=>misticpayDialog.close();
misticpayDialog.addEventListener('cancel',e=>{if(misticpayBusy)e.preventDefault();});
misticpayDialog.addEventListener('close',()=>{cpfField.value='';});
$('#catalog-misticpay-form').onsubmit=async e=>{
 e.preventDefault();
 const view=reservationView;
 if(misticpayBusy||!isCurrentReservation(view)||!view.booking)return;
 const cpf=cpfField.value.replace(/[.\s-]/g,'');
 const errorMessage=$('#catalog-misticpay-error');
 if(!/^\d{11}$/.test(cpf)){errorMessage.textContent='Informe os 11 dígitos do CPF.';return;}
 misticpayBusy=true;errorMessage.textContent='';cpfField.value='';
 const submit=$('#catalog-misticpay-submit'),close=$('#catalog-misticpay-close');
 submit.disabled=true;close.disabled=true;
 try{
  const payment=await api(`bookings/${view.token}/misticpay`,{cpf});
  if(isCurrentReservation(view)){
   misticpayDialog.close();
   updateMisticpay(view,payment);
  }
 }catch(error){if(isCurrentReservation(view))errorMessage.textContent=error.message;}
 finally{misticpayBusy=false;submit.disabled=false;close.disabled=false;}
};
$('#catalog-confirmation').onclick=async e=>{
 const copyButton=e.target.closest('[data-misticpay-copy]');
 if(copyButton){
  const code=$('#misticpay-copy-code');
  try{await navigator.clipboard.writeText(code.value);copyButton.textContent='Código copiado';}
  catch{code.select();}
  return;
 }
 const button=e.target.closest('[data-payment]');if(!button||button.disabled)return;
 const view=reservationView;
 if(!isCurrentReservation(view)||!view.booking)return;
 $('#catalog-error').textContent='';
 const {payment,method}=button.dataset;
 if(payment==='misticpay/check'){await checkMisticpay(view,true);return;}
 if(payment==='misticpay'){
  $('#catalog-misticpay-error').textContent='';
  misticpayDialog.showModal();
  return;
 }
 const buttons=$('#catalog-confirmation').querySelectorAll('[data-payment]');
 buttons.forEach(option=>{option.disabled=true;});
 const body=payment==='checkout'&&method?{payment_method:method}:{};
 try{
  const result=await api(`bookings/${view.token}/${payment}`,body);
  if(isCurrentReservation(view))location.assign(result.path||result.checkout_url);
 }catch(error){
  if(isCurrentReservation(view))$('#catalog-error').textContent=error.message;
  buttons.forEach(option=>{option.disabled=false;});
 }
};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('#catalog-date').min=today;$('#catalog-date').value=today;
const last=new Date(today+'T12:00:00Z');last.setUTCDate(last.getUTCDate()+180);$('#catalog-date').max=last.toISOString().slice(0,10);
function showCatalogView(){
 clearTimeout(paymentTimer);
 paymentCheck?.abort();
 reservationView=null;
 if(misticpayDialog.open)misticpayDialog.close();
 const token=currentToken();
 if(token)showConfirmation(token);
 else{
  $('#catalog-confirmation').hidden=true;
  $('#catalog-search').hidden=false;
  search();
 }
}
document.addEventListener('visibilitychange',()=>{
 clearTimeout(paymentTimer);
 if(!document.hidden)checkMisticpay(reservationView);
});
window.addEventListener('hashchange',showCatalogView);
window.addEventListener('pagehide',()=>{
 pageSuspended=true;
 clearTimeout(paymentTimer);
 paymentCheck?.abort();
});
window.addEventListener('pageshow',event=>{
 if(!event.persisted)return;
 pageSuspended=false;
 showCatalogView();
});
showCatalogView();
