const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);
const dateLabel=date=>new Date(date+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
const key=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
let catalog,selection,requestKey,reservationView,misticpayBusy=false;
let paymentCheck,paymentTimer,pageSuspended=false;
let splitCheck,splitTimer;
const splitTokenPattern=/^[a-f0-9]{32}\.[1-9]\d{0,15}\.[a-f0-9]{64}$/;
async function api(path,body,signal,method=body?'POST':'GET'){
 const response=await fetch('/api/public/'+path,{
  method,headers:body?{'Content-Type':'application/json'}:{},
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
function misticpayDetails(payment,canAct,shareTitle=''){
 const pending=canAct&&payment.status==='pending';
 const qr=payment.qr_code;
 const qrImage=pending&&typeof qr==='string'&&qr.length<=200_000&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(qr)
  ?`<img class="misticpay-qr" src="${esc(qr)}" alt="QR Code do Pix via MisticPay">`:'';
 const code=pending&&typeof payment.copy_paste==='string'&&payment.copy_paste.length<=4096
  ?payment.copy_paste:'';
 const canCheck=canAct&&['pending','review','creating','unknown'].includes(payment.status);
 return `<section class="misticpay-details" aria-labelledby="misticpay-title">
  <h3 id="misticpay-title">${shareTitle||'Pix via MisticPay'}</h3>
  <p>${misticpayStatus[payment.status]||'Consulte a arena sobre este pagamento.'}</p>
  ${qrImage}
  ${code?`<label>Pix copia e cola<input id="misticpay-copy-code" readonly value="${esc(code)}"></label>`:''}
  ${code||canCheck?`<div class="catalog-payment-actions">
   ${code?'<button type="button" class="primary" data-misticpay-copy>Copiar código Pix</button>':''}
   ${canCheck?`<button type="button" class="outline" data-payment="${shareTitle?'split/check':'misticpay/check'}">Verificar pagamento</button>`:''}
  </div>`:''}
 </section>`;
}
function wholePaymentChoices(booking){
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
const splitShareLabels={
 uncreated:'Aguardando pagamento',creating:'Gerando Pix',pending:'Pix disponível',approved:'Paga',
 unknown:'Em consulta',review:'Em conferência',cancelled:'Cancelada',failed:'Indisponível',refunded:'Devolvida'
};
function splitSharePath(path){
 const prefix='/catalogo#cota:';
 return typeof path==='string'&&path.startsWith(prefix)&&splitTokenPattern.test(path.slice(prefix.length))?path:null;
}
function depositPlanDetails(plan){
 if(!plan)return '<p>Carregando pagamento da entrada…</p>';
 const steps=plan.shares.map(share=>{
  const entry=share.index===1;
  const path=splitSharePath(share.path);
  const payable=path&&!share.locked&&(entry||plan.deposit_confirmed)&&share.status!=='approved';
  const status=share.status==='approved'?'Pagamento confirmado':
   !entry&&!plan.deposit_confirmed?'Disponível após confirmar a entrada':splitShareLabels[share.status];
  return `<li>
   <div><strong>${entry?'Entrada de 50%':'Saldo da quadra'}</strong><small>${status||'Em consulta'}</small></div>
   <strong>${money(share.amount_cents)}</strong>
   ${payable?`<a class="outline" href="${esc(path)}" target="_blank" rel="noopener noreferrer">${entry?'Pagar entrada':'Pagar saldo'} ↗</a>`:''}
  </li>`;
 }).join('');
 return `<h3 id="catalog-split-heading" tabindex="-1">Entrada e saldo via Pix</h3>
  <ul class="catalog-split-list">${steps}</ul>
  ${plan.editable?'<button type="button" class="outline" data-cancel-split>Voltar ao pagamento total</button>':''}`;
}
function splitPlanDetails(plan){
 if(!plan)return '<p>Carregando cotas…</p>';
 const shares=plan.shares.map(share=>{
  const path=splitSharePath(share.path);
  const index=esc(share.index);
  return `<li>
   <div><strong>Cota ${index}</strong><small>${splitShareLabels[share.status]||'Em consulta'}</small></div>
   <strong>${money(share.amount_cents)}</strong>
   ${path&&share.status!=='approved'?`<div class="catalog-split-actions"><button type="button" class="outline" data-copy-split="${index}" aria-label="Copiar link da cota ${index}">Copiar link</button><a class="outline" href="${esc(path)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir cota ${index}">Abrir cota ↗</a></div>`:''}
  </li>`;
 }).join('');
 const openShares=plan.shares.some(share=>share.status!=='approved'&&splitSharePath(share.path));
 return `<h3 id="catalog-split-heading" tabindex="-1">Pix dividido</h3>
  <p class="catalog-split-summary"><strong>${esc(plan.paid_count)} de ${esc(plan.count)} cotas pagas</strong> · ${money(plan.paid_cents)} de ${money(plan.total)}</p>
  <progress class="catalog-split-progress" max="${esc(plan.count)}" value="${esc(plan.paid_count)}" aria-label="Cotas pagas"></progress>
  ${openShares?'<p>Envie um link diferente para cada pessoa pagar sua cota.</p>':''}
  <div class="catalog-split-actions">
   ${openShares&&plan.shares.length>1?'<button type="button" class="outline" data-copy-split-page>Copiar links da página</button>':''}
   ${plan.editable?'<button type="button" class="outline" data-configure-split>Alterar quantidade</button><button type="button" class="outline" data-cancel-split>Voltar ao pagamento total</button>':''}
  </div>
  <ul class="catalog-split-list">${shares}</ul>
  ${plan.pages>1?`<div class="catalog-split-actions" aria-label="Páginas de cotas">
   <button type="button" class="outline" data-split-page="${esc(plan.page-1)}" ${plan.page<=1?'disabled':''}>Anterior</button>
   <span>Página ${esc(plan.page)} de ${esc(plan.pages)}</span>
   <button type="button" class="outline" data-split-page="${esc(plan.page+1)}" ${plan.page>=plan.pages?'disabled':''}>Próxima</button>
  </div>`:''}
  <div data-split-copy-fallback></div>`;
}
function paymentChoices(view,booking){
 if(booking.split){
  const deposit=booking.split.mode==='deposit';
  return `<section class="catalog-split-panel" id="catalog-split-panel" aria-label="${deposit?'Pagamento da entrada e do saldo':'Pagamento dividido'}">${deposit?depositPlanDetails(view.plan):splitPlanDetails(view.plan)}</section>`;
 }
 const whole=wholePaymentChoices(booking);
 if(!booking.split_ready||booking.paid||booking.status!=='confirmed')return whole;
 return `<div class="catalog-payment-actions">
  <button type="button" class="primary" data-pay-whole aria-expanded="${Boolean(view.payWhole)}" aria-controls="catalog-whole-payment">Pagar o total</button>
  ${booking.deposit_ready!==false?`<button type="button" class="outline" data-pay-deposit>Pagar 50% via Pix · ${money(Math.ceil(booking.total/2))}</button>`:''}
  <button type="button" class="outline" data-configure-split>Dividir com amigos</button>
 </div><div id="catalog-whole-payment" ${view.payWhole?'':'hidden'}>${whole}</div>`;
}
function renderConfirmation(view,b){
 view.booking=b;
 const deposit=b.split?.mode==='deposit';
 const confirmed=b.paid||b.split?.deposit_confirmed;
 let summary='O horário está reservado. O pagamento está pendente.';
 if(b.status==='cancelled')summary='Esta reserva foi cancelada pela arena.';
 else if(b.paid)summary='Pagamento integral confirmado.';
 else if(b.split?.deposit_confirmed)summary=`Entrada confirmada. Saldo pendente de ${money(b.split.remaining_cents)}.`;
 else if(deposit)summary='Pague a entrada para confirmar a reserva.';
 else if(b.misticpay)summary='';
 const privateLinkHelp=b.split&&!deposit?'Guarde o link privado da reserva e envie aos amigos os links das cotas.':'Guarde este link privado para consultar sua reserva.';
 const state=b.status==='cancelled'?'RESERVA CANCELADA':confirmed?'RESERVA CONFIRMADA':'HORÁRIO RESERVADO';
 $('#catalog-confirmation').innerHTML=`<span class="eyebrow">${state}</span><h2>${b.status==='cancelled'?'Entre em contato com a arena.':`Tudo certo, ${esc(b.customer)}!`}</h2><p>${esc(b.court_name)} · ${dateLabel(b.date)} · ${esc(b.start)} – ${esc(b.end)}</p><p class="catalog-total">${money(b.total)}</p>${summary?`<p role="status">${summary}</p>`:''}${paymentChoices(view,b)}<p>${privateLinkHelp}</p><button id="copy-reservation" class="outline">Copiar link da reserva</button> <a class="outline" href="/catalogo">Fazer outra reserva</a>`;
 $('#copy-reservation').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$('#copy-reservation').textContent='Link copiado';}catch{$('#catalog-error').textContent='Copie o endereço desta página para guardar seu link.';}};
 schedulePaymentCheck();
 scheduleSplitRefresh();
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
  if(isCurrentReservation(view)){
   renderConfirmation(view,booking);
   if(booking.split)await refreshSplit(view,1,true);
  }
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
function applySplitPlan(view,plan){
 const changed=JSON.stringify(view.plan)!==JSON.stringify(plan);
 view.plan=plan;
 const paid=plan.status==='approved';
 const booking=view.booking;
 const deposit=plan.mode==='deposit';
 const depositChanged=deposit&&(Boolean(booking.split?.deposit_confirmed)!==Boolean(plan.deposit_confirmed)||
  booking.split?.remaining_cents!==plan.remaining_cents);
 if(!booking.split||Boolean(booking.paid)!==paid||booking.split.mode!==plan.mode||depositChanged){
  renderConfirmation(view,{...booking,paid,split:plan});
 }else if(changed){
  $('#catalog-split-panel').innerHTML=deposit?depositPlanDetails(plan):splitPlanDetails(plan);
 }
}
function sharePaymentForm(){
 return `<form class="catalog-split-share-form" data-split-share-form>
  <label>Nome do pagador<input name="name" maxlength="120" autocomplete="name" required></label>
  <label>CPF do pagador<input name="cpf" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" required></label>
  <p>A MisticPay usa esses dados para emitir o Pix.</p>
  <p id="catalog-split-share-error" role="alert"></p>
  <button class="primary" type="submit">Gerar código Pix</button>
 </form>`;
}
function renderSplitShare(view,share){
 if(JSON.stringify(view.share)===JSON.stringify(share))return;
 view.share=share;
 const deposit=share.mode==='deposit',entry=deposit&&share.index===1;
 const badge=deposit?(entry?'ENTRADA DE 50%':'SALDO DA QUADRA'):`COTA ${esc(share.index)} DE ${esc(share.count)}`;
 const title=deposit?(entry?'Pague a entrada':'Pague o saldo'):'Pague sua cota';
 const paidTitle=deposit?(entry?'Entrada confirmada':'Saldo confirmado'):'Cota paga';
 const payment=share.locked?'<p>O Pix do saldo fica disponível após a confirmação da entrada.</p>':
  share.status==='uncreated'?sharePaymentForm():misticpayDetails(share,true,deposit?(entry?'Pix da entrada':'Pix do saldo'):'Pix da cota');
 $('#catalog-confirmation').innerHTML=`<span class="eyebrow">${badge}</span>
  <h2>${share.status==='approved'?paidTitle:title}</h2>
  <p>${esc(share.court_name)} · ${dateLabel(share.date)} · ${esc(share.start)} – ${esc(share.end)}</p>
  <p class="catalog-total">${money(share.amount_cents)}</p>
  ${payment}
  ${deposit?`<p>${entry&&share.status==='approved'?'Sua reserva está confirmada. Consulte o saldo no link da reserva.':'Acompanhe o pagamento pelo link da reserva.'}</p>`:''}`;
 scheduleSplitRefresh();
}
function scheduleSplitRefresh(){
 clearTimeout(splitTimer);
 const view=reservationView;
 if(splitCheck||document.hidden||!isCurrentReservation(view)||view.stopSplitPolling)return;
 const sharePending=view.shareToken&&automaticPaymentStates.includes(view.share?.status);
 const planPending=view.booking?.split&&!view.booking.paid&&view.booking.status!=='cancelled';
 if(!sharePending&&!planPending)return;
 if(sharePending)view.nextSplitProviderCheck??=Date.now()+providerCheckInterval;
 splitTimer=setTimeout(()=>refreshSplit(view),sharePending?paymentStatusInterval:5_000);
}
async function splitShareStatus(view,path,signal){
 const previous=view.share;
 if(!previous)return api(path,undefined,signal);
 const {status}=await api(path+'/check',undefined,signal);
 if(status===previous.status)return previous;
 if(status==='pending')return api(path,undefined,signal);
 return {...previous,status,qr_code:null,copy_paste:null};
}
async function refreshSplit(view,page=view?.plan?.page||1,manual=false,checkProvider=false){
 if(!isCurrentReservation(view)||document.hidden||(!view.shareToken&&!view.booking?.split))return;
 if(splitCheck&&!manual)return;
 splitCheck?.abort();
 clearTimeout(splitTimer);
 const controller=new AbortController();
 splitCheck=controller;
 const active=()=>isCurrentReservation(view)&&!controller.signal.aborted;
 if(manual)$('#catalog-error').textContent='';
 try{
  if(view.shareToken){
   const path='split/'+view.shareToken;
   const share=await splitShareStatus(view,path,controller.signal);
   if(!active())return;
   renderSplitShare(view,share);
   const now=Date.now();
   const pending=automaticPaymentStates.includes(share.status);
   if((checkProvider&&(pending||share.status==='review'))||(pending&&now>=view.nextSplitProviderCheck)){
    view.nextSplitProviderCheck=now+providerCheckInterval;
    const payment=await api(path+'/check',{},controller.signal);
    if(active())renderSplitShare(view,payment);
   }
  }else{
   const plan=await api(`bookings/${view.token}/split?page=${page}`,undefined,controller.signal);
   if(active())applySplitPlan(view,plan);
  }
 }catch(error){
  if(!active())return;
  if(error.status===404&&view.booking?.split){
   try{
    const booking=await api(`bookings/${view.token}`,undefined,controller.signal);
    if(!active())return;
    if(!booking.split){
     view.plan=null;
     renderConfirmation(view,booking);
     return;
    }
   }catch{}
  }
  if(!active())return;
  if([401,403,404,410].includes(error.status))view.stopSplitPolling=true;
  if(manual||view.stopSplitPolling)$('#catalog-error').textContent=error.message;
  if(view.shareToken&&(!view.share||view.stopSplitPolling))$('#catalog-confirmation').textContent='Não foi possível abrir a cota.';
  if(!view.shareToken&&!view.plan)$('#catalog-split-panel').innerHTML='<p>As cotas estão indisponíveis.</p><button type="button" class="outline" data-split-page="1">Tentar novamente</button>';
 }finally{
  if(splitCheck===controller)splitCheck=null;
  if(isCurrentReservation(view))scheduleSplitRefresh();
 }
}
function showSplitShare(token){
 const shareToken=token.slice('cota:'.length);
 const view={token,shareToken};
 reservationView=view;
 $('#catalog-error').textContent='';
 $('#catalog-search').hidden=true;
 $('#catalog-confirmation').hidden=false;
 if(!splitTokenPattern.test(shareToken)){
  view.stopSplitPolling=true;
  $('#catalog-confirmation').textContent='Link de cota inválido.';
  return;
 }
 $('#catalog-confirmation').textContent='Carregando cota…';
 void refreshSplit(view,1,true);
}
const splitDialog=$('#catalog-split-modal');
const splitCount=$('#catalog-split-count');
const splitPreview=$('#catalog-split-preview');
function showSplitDialog(view){
 splitCount.max=String(view.booking.total);
 splitCount.value=String(view.plan?.count||2);
 $('#catalog-split-error').textContent='';
 $('#catalog-split-submit').textContent=view.plan?'Atualizar links das cotas':'Criar links das cotas';
 updateSplitPreview();
 splitDialog.showModal();
}
async function saveSplitPlan(view,body){
 const plan=await api(`bookings/${view.token}/split`,body);
 if(!isCurrentReservation(view))return;
 splitCheck?.abort();
 splitCheck=null;
 if(splitDialog.open)splitDialog.close();
 applySplitPlan(view,plan);
 scheduleSplitRefresh();
 $('#catalog-split-heading')?.focus();
}
function updateSplitPreview(){
 const count=splitCount.valueAsNumber;
 const view=reservationView;
 const total=view?.booking?.total;
 if(!Number.isSafeInteger(count)||count<2||count>total){
  splitPreview.textContent='';
  return;
 }
 const amount=Math.floor(total/count),remainder=total%count;
 const portion=(number,value)=>`${number} ${number===1?'cota':'cotas'} de ${money(value)}`;
 splitPreview.textContent=remainder?`${portion(remainder,amount+1)} e ${portion(count-remainder,amount)}.`:`${portion(count,amount)}.`;
}
splitCount.addEventListener('input',updateSplitPreview);
$('#catalog-split-close').onclick=()=>splitDialog.close();
splitDialog.addEventListener('cancel',event=>{if(reservationView?.splitCreating)event.preventDefault();});
$('#catalog-split-form').onsubmit=async event=>{
 event.preventDefault();
 const view=reservationView;
 if(!isCurrentReservation(view)||!view.booking||view.splitCreating)return;
 const count=splitCount.valueAsNumber;
 if(!Number.isSafeInteger(count)||count<2||count>view.booking.total)return;
 const submit=$('#catalog-split-submit'),close=$('#catalog-split-close'),message=$('#catalog-split-error');
 submit.disabled=true;close.disabled=true;message.textContent='';
 view.splitCreating=true;
 try{
  await saveSplitPlan(view,{count});
 }catch(error){
  if(isCurrentReservation(view))message.textContent=error.message;
 }finally{
  view.splitCreating=false;
  submit.disabled=false;close.disabled=false;
 }
};
async function startDeposit(view,button){
 if(view.splitCreating||!view.booking?.split_ready||view.booking.split)return;
 view.splitCreating=true;button.disabled=true;
 $('#catalog-error').textContent='';
 try{await saveSplitPlan(view,{count:2,mode:'deposit'});}
 catch(error){if(isCurrentReservation(view))$('#catalog-error').textContent=error.message;}
 finally{view.splitCreating=false;button.disabled=false;}
}
async function cancelSplitPlan(view,button){
 if(view.splitCreating||!view.plan?.editable)return;
 const prompt=view.plan.mode==='deposit'?'Voltar ao pagamento total? Os links da entrada e do saldo vão expirar.':'Voltar ao pagamento total? Os links das cotas atuais vão expirar.';
 if(!window.confirm(prompt))return;
 button.disabled=true;
 view.splitCreating=true;
 try{
  await api(`bookings/${view.token}/split`,undefined,undefined,'DELETE');
  if(!isCurrentReservation(view))return;
  splitCheck?.abort();
  splitCheck=null;
  const booking=await api(`bookings/${view.token}`);
  if(isCurrentReservation(view)){
   view.plan=null;
   view.payWhole=true;
   renderConfirmation(view,booking);
  }
 }catch(error){
  if(isCurrentReservation(view))$('#catalog-error').textContent=error.message;
 }finally{
  view.splitCreating=false;
  button.disabled=false;
 }
}
async function copySplitLinks(view,button,page){
 const rows=view.plan?.shares.filter(share=>
  (page||String(share.index)===button.dataset.copySplit)&&share.status!=='approved'&&splitSharePath(share.path)
 );
 if(!rows?.length)return;
 const links=rows.map(share=>{
  const url=new URL(share.path,location.origin).href;
  return page?`Cota ${share.index} · ${money(share.amount_cents)}\n${url}`:url;
 }).join('\n\n');
 const fallback=$('[data-split-copy-fallback]');
 try{
  await navigator.clipboard.writeText(links);
  button.textContent=page?'Links copiados':'Link copiado';
  fallback.replaceChildren();
 }catch{
  const label=document.createElement('label');
  label.textContent=page?'Copie os links abaixo':'Copie o link abaixo';
  const area=document.createElement('textarea');
  area.rows=page?4:2;area.readOnly=true;area.value=links;
  label.append(area);fallback.replaceChildren(label);
  area.focus();area.select();
 }
}
$('#catalog-confirmation').addEventListener('submit',async e=>{
 const form=e.target.closest('[data-split-share-form]');
 if(!form)return;
 e.preventDefault();
 const view=reservationView;
 if(!isCurrentReservation(view)||!view.shareToken||view.shareCreating)return;
 const fields=new FormData(form);
 const name=String(fields.get('name')||'').trim(),cpf=String(fields.get('cpf')||'').replace(/[.\s-]/g,'');
 const message=$('#catalog-split-share-error');
 if(!name||!/^\d{11}$/.test(cpf)){message.textContent='Informe o nome e os 11 dígitos do CPF.';return;}
 const submit=form.querySelector('button[type=submit]');
 view.shareCreating=true;submit.disabled=true;message.textContent='';
 form.querySelector('[name=cpf]').value='';
 try{
  const share=await api('split/'+view.shareToken,{name,cpf});
  if(isCurrentReservation(view))renderSplitShare(view,share);
 }catch(error){
  if(isCurrentReservation(view)){
   message.textContent=error.message;
   void refreshSplit(view);
  }
 }finally{
  view.shareCreating=false;submit.disabled=false;
 }
});
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
 const view=reservationView;
 if(!isCurrentReservation(view))return;
 if(view.splitCreating)return;
 const deposit=e.target.closest('[data-pay-deposit]');
 if(deposit){await startDeposit(view,deposit);return;}
 const configure=e.target.closest('[data-configure-split]');
 if(configure&&view.booking){showSplitDialog(view);return;}
 const cancelSplit=e.target.closest('[data-cancel-split]');
 if(cancelSplit){await cancelSplitPlan(view,cancelSplit);return;}
 const whole=e.target.closest('[data-pay-whole]');
 if(whole){
  view.payWhole=!view.payWhole;
  whole.setAttribute('aria-expanded',String(view.payWhole));
  $('#catalog-whole-payment').hidden=!view.payWhole;
  return;
 }
 const shareCopy=e.target.closest('[data-copy-split]');
 const pageCopy=e.target.closest('[data-copy-split-page]');
 if(shareCopy||pageCopy){await copySplitLinks(view,shareCopy||pageCopy,Boolean(pageCopy));return;}
 const page=e.target.closest('[data-split-page]');
 if(page){
  if(!page.disabled)await refreshSplit(view,Number(page.dataset.splitPage),true);
  return;
 }
 const button=e.target.closest('[data-payment]');if(!button||button.disabled)return;
 $('#catalog-error').textContent='';
 const {payment,method}=button.dataset;
 if(payment==='split/check'){
  button.disabled=true;
  try{await refreshSplit(view,undefined,true,true);}
  finally{button.disabled=false;}
  return;
 }
 if(!view.booking)return;
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
 clearTimeout(splitTimer);
 paymentCheck?.abort();
 splitCheck?.abort();
 splitCheck=null;
 reservationView=null;
 if(misticpayDialog.open)misticpayDialog.close();
 if(splitDialog.open)splitDialog.close();
 const token=currentToken();
 $('.catalog-hero').hidden=Boolean(token);
 if(token.startsWith('cota:'))showSplitShare(token);
 else if(token)showConfirmation(token);
 else{
  $('#catalog-confirmation').hidden=true;
  $('#catalog-search').hidden=false;
  search();
 }
}
document.addEventListener('visibilitychange',()=>{
 clearTimeout(paymentTimer);
 clearTimeout(splitTimer);
 if(!document.hidden){
  checkMisticpay(reservationView);
  if(!reservationView?.stopSplitPolling)void refreshSplit(reservationView);
 }
});
window.addEventListener('hashchange',showCatalogView);
window.addEventListener('pagehide',()=>{
 pageSuspended=true;
 clearTimeout(paymentTimer);
 clearTimeout(splitTimer);
 paymentCheck?.abort();
 splitCheck?.abort();
});
window.addEventListener('pageshow',event=>{
 if(!event.persisted)return;
 pageSuspended=false;
 showCatalogView();
});
showCatalogView();
