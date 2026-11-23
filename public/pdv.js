const pdv=(()=>{
 const dateField=$('#pdv-date');
 const dialog=$('#pdv-tab-dialog');
 const detail=$('#pdv-tab-detail');
 const tabError=$('#pdv-tab-error');
 const paymentMethods=['Pix','Dinheiro','Cartão de crédito','Cartão de débito','Transferência'];
 const dateTime=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});
 const sectionTabs=[$('#pdv-comandas-tab'),$('#pdv-products-tab')];
 let dashboard,loadRequest,activeTab,activeBookingId,tabRequest=0,tabBusy=false,addAttempt,participantAttempt;
 dateField.value=today();

 function showSection(tab){
  for(const button of sectionTabs){
   const selected=button===tab;
   button.setAttribute('aria-selected',String(selected));
   button.tabIndex=selected?0:-1;
   $('#'+button.getAttribute('aria-controls')).hidden=!selected;
  }
 }

 for(const tab of sectionTabs){
  tab.onclick=()=>showSection(tab);
  tab.onkeydown=event=>{
   const other=sectionTabs.find(button=>button!==tab);
   const target={ArrowLeft:other,ArrowRight:other,Home:sectionTabs[0],End:sectionTabs[1]}[event.key];
   if(!target)return;
   event.preventDefault();
   showSection(target);
   target.focus();
  };
 }

 function tabBadge(status){
  if(status==='closed')return '<span class="badge paid">Fechada</span>';
  if(status==='cancelled')return '<span class="badge cancelled">Cancelada</span>';
  return '<span class="badge">Aberta</span>';
 }

 function renderDashboard(data){
  const revenue=data.revenue;
  $('#pdv-stats').innerHTML=
   stat('Total recebido',money(revenue.total_cents),'Quadras e consumo','↑')+
   stat('Quadras recebidas',money(revenue.courts_cents),'Pagamentos e entradas no dia','▱')+
   stat('Consumo recebido',money(revenue.consumption_cents),'Baixas do dia','▤')+
   stat('Consumo em aberto',money(revenue.open_consumption_cents),'Nas reservas desta data','◷');
  $('#pdv-tabs-description').textContent=`${data.tabs.length} ${data.tabs.length===1?'comanda':'comandas'} das reservas desta data`;
  $('#pdv-tabs').innerHTML=data.tabs.length?data.tabs.map(tab=>`<article class="pdv-tab-card">
   <div class="pdv-card-heading"><h3>${esc(tab.customer)}</h3>${tabBadge(tab.status)}</div>
   <p>${esc(tab.court_name)} · ${esc(tab.start)}–${esc(tab.end)}</p>
   <small>Comanda #${esc(tab.booking_id)}</small>
   ${tab.participant_count?`<small>${esc(tab.participant_count)} ${tab.participant_count===1?'participante':'participantes'} · saldo ${money(tab.consumption_balance_cents)}</small>`:''}
   <div class="pdv-card-footer"><div><small>Consumo</small><strong>${money(tab.consumption_cents)}</strong></div><button type="button" class="outline" data-pdv-tab="${esc(tab.booking_id)}">Ver comanda</button></div>
  </article>`).join(''):'<div class="empty"><h3>Nenhuma comanda nesta data</h3><p>As comandas são abertas com as reservas.</p></div>';
  renderProducts(data.products);
 }

 function renderProducts(products){
  $('#pdv-products').innerHTML=products.length?`<ul class="pdv-products-list">${products.map(product=>`<li>
   <span><strong>${esc(product.name)}</strong>${product.active?'':'<small>Inativo</small>'}</span>
   <strong>${money(product.price_cents)}</strong>
   <button type="button" class="outline" data-pdv-edit-product="${esc(product.id)}" aria-label="Editar ${esc(product.name)}">Editar</button>
  </li>`).join('')}</ul>`:'<div class="empty"><p>Cadastre os produtos que serão lançados nas comandas.</p></div>';
 }

 function refresh({force=false}={}){
  const date=dateField.value||today();
  dateField.value=date;
  if(!force&&loadRequest?.date===date)return loadRequest.promise;
  const request={date};
  loadRequest=request;
  if(dashboard?.date!==date){
   $('#pdv-stats').replaceChildren();
   $('#pdv-tabs').replaceChildren();
   $('#pdv-tabs-description').textContent='Carregando comandas…';
  }
  $('#pdv-load-error').textContent='';
  request.promise=api('pdv?date='+encodeURIComponent(date)).then(data=>{
   if(loadRequest!==request)return;
   dashboard=data;
   renderDashboard(data);
  }).catch(error=>{
   if(loadRequest!==request)return;
   $('#pdv-load-error').textContent=error.message||'Não foi possível carregar o PDV.';
   if(dashboard?.date!==date)$('#pdv-tabs-description').textContent='';
  }).finally(()=>{if(loadRequest===request)loadRequest=null;});
  return request.promise;
 }

 function productPrice(input){
  const value=input.trim();
  if(!/^\d+(?:[.,]\d{1,2})?$/.test(value))throw Error('Informe um preço válido, como 12,50.');
  const [whole,fraction='']=value.replace(',','.').split('.');
  const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(cents)||cents<=0)throw Error('Informe um preço maior que zero.');
  return cents;
 }

 function openProduct(product){
  openModal(product?'Editar produto':'Novo produto',`
   <label>Nome <input name="name" value="${esc(product?.name)}" maxlength="100" required></label>
   <label>Preço (R$) <input name="price" inputmode="decimal" value="${product?(product.price_cents/100).toFixed(2).replace('.',','):''}" placeholder="12,50" maxlength="18" required></label>
   <label class="check-label"><input type="checkbox" name="active" ${!product||product.active?'checked':''}> Disponível para novas comandas</label>
  `,async form=>{
   const values={name:form.name,price_cents:productPrice(form.price),active:form.active==='on'};
   const updated=product?await api(`pdv/products/${product.id}`,values,'PATCH'):await api('pdv/products',values);
   if(dashboard){
    dashboard.products=[...dashboard.products.filter(entry=>entry.id!==updated.id),updated]
     .sort((left,right)=>left.name.localeCompare(right.name,'pt-BR'));
    renderProducts(dashboard.products);
   }
   if(dialog.open&&activeTab&&!tabBusy)renderTab(activeTab);
  },'Salvar produto');
 }

 function participantSelect(participants,selected){
  if(!participants.length)return '';
  const options=participants.map(person=>`<option value="${esc(person.id)}"${person.id===selected?' selected':''}>${esc(person.name)}</option>`).join('');
  return `<label class="pdv-assignment">Consumo de <select name="participant_id"><option value="">Compartilhado</option>${options}</select></label>`;
 }

 function itemRows(items,participants,editable,bookingCancelled){
  if(!items.length)return '<p class="pdv-muted">Nenhum item lançado.</p>';
  return `<ul class="pdv-items">${items.map(item=>`<li>
   <div><strong>${esc(item.name)}</strong><small>${esc(item.quantity)} × ${money(item.price_cents)}</small>
    ${item.participant_name?`<small>Individual · ${esc(item.participant_name)}</small>`:participants.length?'<small>Compartilhado</small>':''}</div>
   <strong>${money(item.total_cents)}</strong>
   ${editable?`<form data-pdv-item="${esc(item.id)}" class="pdv-item-form${participants.length?' pdv-assignment-form':''}">
    <label>Qtd. <input type="number" name="quantity" min="1" step="1" value="${esc(item.quantity)}" ${bookingCancelled?`max="${esc(item.quantity)}"`:''} aria-label="Quantidade de ${esc(item.name)}" required></label>
    ${participantSelect(participants,item.participant_id)}
    <button type="submit" class="outline">Atualizar</button>
    <button type="button" class="table-button cancel" data-pdv-remove="${esc(item.id)}" aria-label="Remover ${esc(item.name)}">Remover</button>
   </form>`:''}
  </li>`).join('')}</ul>`;
 }

 function participantFields(person){
  return `<label>Nome <input name="name" value="${esc(person?.name)}" maxlength="120" required></label>
   <label>WhatsApp com DDD <input name="whatsapp" type="tel" value="${esc(person?.whatsapp)}" placeholder="(62) 99999-9999" maxlength="30" required></label>`;
 }

 function participantWhatsApp(person,tab){
  const phone=String(person.whatsapp||'').replace(/\D/g,'');
  if(!/^[1-9]\d{7,14}$/.test(phone))return '';
  const text=`Olá, ${person.name}! Sua parte do consumo na comanda #${tab.booking_id} da quadra ${tab.court_name} é de ${money(person.amount_cents)}.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
 }

 function paymentSelect(){
  return `<label>Forma de pagamento <select name="method" required><option value="">Selecione</option>${paymentMethods.map(method=>`<option>${method}</option>`).join('')}</select></label>`;
 }

 function renderParticipants(tab){
  const participants=tab.participants||[];
  const open=tab.status==='open';
  const canChangeDivision=open&&!tab.division_locked;
  if(!participants.length&&!canChangeDivision)return '';
  const rows=participants.map(person=>{
   const paid=Boolean(person.paid_at);
   const contact=open&&!paid;
   const canSettle=contact&&person.amount_cents>0;
   const whatsapp=canSettle?participantWhatsApp(person,tab):'';
   const id=esc(person.id);
   const status=paid?`Pago por ${esc(person.method)}`:person.amount_cents>0?'Em aberto':'Sem valor a pagar';
   return `<li>
    <div class="pdv-participant-heading"><div><strong>${esc(person.name)}</strong><small>${esc(person.whatsapp)}</small></div>
     <div><strong>${money(person.amount_cents)}</strong><small>${status}</small></div></div>
    <p class="pdv-participant-breakdown">Individual ${money(person.individual_cents??0)} · Compartilhado ${money(person.shared_cents??person.amount_cents)}</p>
    ${contact?`<div class="pdv-participant-actions">
     ${whatsapp?`<a class="outline" href="${esc(whatsapp)}" target="_blank" rel="noopener noreferrer" aria-label="Cobrar ${esc(person.name)} pelo WhatsApp">WhatsApp ↗</a>`:''}
     ${!tab.division_locked?`<button type="button" class="table-button cancel" data-pdv-remove-participant="${id}" aria-label="Remover ${esc(person.name)} da divisão">Remover</button>`:''}
    </div>
    <details><summary>Editar contato</summary><form data-pdv-participant-edit="${id}" class="pdv-participant-form">
     ${participantFields(person)}<button type="submit" class="outline">Salvar contato</button>
    </form></details>`:''}
    ${canSettle?`<details><summary>Registrar pagamento</summary><form data-pdv-participant-pay="${id}" class="pdv-settle-form">
     ${paymentSelect()}<button type="submit" class="primary">Confirmar ${money(person.amount_cents)}</button>
    </form></details>`:''}
   </li>`;
  }).join('');
  return `<section class="pdv-participants" aria-labelledby="pdv-participants-heading">
   <h3 id="pdv-participants-heading">Dividir consumo</h3>
   ${participants.length?`<p class="pdv-participants-summary">${participants.length} ${participants.length===1?'participante':'participantes'} · ${money(tab.participant_paid_cents)} recebido · ${money(tab.consumption_balance_cents)} em aberto</p><ul class="pdv-participants-list">${rows}</ul>`:
    '<p class="pdv-muted">Adicione as pessoas para atribuir itens individuais e dividir os compartilhados.</p>'}
   ${canChangeDivision?`<form data-pdv-participant-add class="pdv-participant-form">${participantFields()}<button type="submit" class="outline">Adicionar pessoa</button></form>`:''}
   ${open&&tab.division_locked?'<p class="pdv-muted">A divisão e os itens ficam fixos após o primeiro pagamento.</p>':''}
  </section>`;
 }

 function renderTab(tab){
  $('#pdv-tab-title').textContent=`Comanda #${tab.booking_id}`;
  const open=tab.status==='open';
  const bookingCancelled=tab.booking_status==='cancelled';
  const canEditItems=open&&!tab.division_locked;
  const canAdd=canEditItems&&!bookingCancelled;
  const participants=tab.participants||[];
  const products=(dashboard?.products||[]).filter(product=>product.active);
  const canSettle=tab.consumption_cents>0;
  const closeWhole=open&&(!canSettle||!tab.participant_count);
  const options=products.map(product=>`<option value="${esc(product.id)}">${esc(product.name)} · ${money(product.price_cents)}</option>`).join('');
  detail.innerHTML=`<div class="pdv-detail-header"><div><h3>${esc(tab.customer)}</h3><p>${esc(tab.court_name)} · ${dateLabel(tab.date)} · ${esc(tab.start)}–${esc(tab.end)}</p></div>${tabBadge(tab.status)}</div>
   <dl class="pdv-tab-totals">
    <div><dt>Quadra · ${bookingCancelled?'cancelada':tab.booking_paid?'paga':'pendente'}</dt><dd>${bookingCancelled?'—':money(tab.booking_total_cents)}</dd>
     ${!bookingCancelled&&tab.booking_uses_deposit&&!tab.booking_paid&&tab.booking_received_cents>0?`<small>${money(tab.booking_received_cents)} recebidos · saldo ${money(tab.booking_total_cents-tab.booking_received_cents)}</small>`:''}</div>
    <div><dt>Consumo</dt><dd>${money(tab.consumption_cents)}</dd></div>
    ${bookingCancelled?'':`<div><dt>Total da reserva e consumo</dt><dd>${money(tab.booking_total_cents+tab.consumption_cents)}</dd></div>`}
   </dl>
   ${tab.paid_at&&tab.method?`<p class="pdv-paid-info">Consumo recebido por ${esc(tab.method)} em ${dateTime.format(new Date(tab.paid_at))}.</p>`:''}
   <section aria-label="Itens da comanda">
    <h3>Itens</h3>
    ${itemRows(tab.items,participants,canEditItems,bookingCancelled)}
   </section>
   ${canAdd?products.length?`<form data-pdv-add class="pdv-add-form${participants.length?' pdv-assignment-form':''}">
    <label>Produto <select name="product_id" required><option value="">Selecione</option>${options}</select></label>
    <label>Qtd. <input name="quantity" type="number" min="1" step="1" value="1" required></label>
    ${participantSelect(participants,null)}
    <button type="submit" class="outline">Adicionar item</button>
   </form>`:'<button type="button" class="outline pdv-add-product" data-pdv-create-product>Cadastrar produto</button>':''}
   ${renderParticipants(tab)}
   ${closeWhole?`<form data-pdv-close class="pdv-settle-form">
    ${canSettle?`<p>Registre aqui o recebimento de <strong>${money(tab.consumption_cents)}</strong> em consumo.</p>
    ${paymentSelect()}`:''}
    <button type="submit" class="primary">${canSettle?'Confirmar recebimento e fechar':'Fechar sem consumo'}</button>
   </form>`:''}`;
 }

 async function openTab(bookingId,date){
  const request=++tabRequest;
  if(date){
   dateField.value=date;
   if(view!=='pdv')setView('pdv');
   showSection(sectionTabs[0]);
  }
  if(!dialog.open||activeBookingId!==bookingId){addAttempt=null;participantAttempt=null;}
  activeBookingId=bookingId;
  activeTab=null;
  tabBusy=false;
  $('#pdv-tab-title').textContent=`Comanda #${bookingId}`;
  tabError.textContent='';
  detail.innerHTML='<p role="status">Carregando comanda…</p>';
  if(!dialog.open)dialog.showModal();
  try{
   const [tab]=await Promise.all([api(`pdv/tabs/${bookingId}`),loadRequest?.promise??refresh()]);
   if(request!==tabRequest||!dialog.open)return;
   activeTab=tab;
   renderTab(tab);
  }catch(error){
   if(request!==tabRequest||!dialog.open)return;
   detail.replaceChildren();
   tabError.textContent=error.message||'Não foi possível abrir a comanda.';
  }
 }

 async function updateTab(action,success){
  if(tabBusy||!activeTab)return;
  const request=tabRequest;
  tabBusy=true;
  const controls=[...detail.querySelectorAll('input,select,button')];
  controls.forEach(control=>{control.disabled=true;});
  tabError.textContent='';
  try{
   const updated=await action(`pdv/tabs/${activeTab.booking_id}`);
   void refresh({force:true});
   if(request!==tabRequest||!dialog.open)return;
   addAttempt=null;
   activeTab=updated;
   renderTab(updated);
   toast(success);
  }catch(error){
   if(request!==tabRequest||!dialog.open)return;
   tabError.textContent=error.message||'Não foi possível atualizar a comanda.';
  }finally{
   if(request===tabRequest)tabBusy=false;
   controls.forEach(control=>{control.disabled=false;});
  }
 }

 function sendAdd(path,form){
  const product_id=Number(form.get('product_id')),quantity=Number(form.get('quantity'));
  const participant_id=selectedParticipant(form),value=JSON.stringify([product_id,quantity,participant_id]);
  if(addAttempt?.value!==value){
   addAttempt={value,key:requestKey()};
  }
  return api(path+'/items',{product_id,quantity,participant_id,request_key:addAttempt.key});
 }

 const requestKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const selectedParticipant=form=>form.get('participant_id')?Number(form.get('participant_id')):null;
 const participantValues=form=>({name:String(form.get('name')||'').trim(),whatsapp:String(form.get('whatsapp')||'').trim()});
 async function sendParticipant(path,form){
  const values=participantValues(form),value=JSON.stringify(values);
  if(participantAttempt?.value!==value)participantAttempt={value,key:requestKey()};
  const attempt=participantAttempt;
  const updated=await api(path+'/participants',{...values,request_key:attempt.key});
  if(participantAttempt===attempt)participantAttempt=null;
  return updated;
 }

 dateField.onchange=()=>refresh();
 $('#pdv-today').onclick=()=>{dateField.value=today();void refresh();};
 $('#pdv-tabs').onclick=event=>{
  const button=event.target.closest('[data-pdv-tab]');
  if(button)void openTab(Number(button.dataset.pdvTab));
 };
 $('#booking-rows').addEventListener('click',event=>{
  const button=event.target.closest('[data-booking-pdv]');
  const booking=button&&bookings.find(row=>row.id===Number(button.dataset.bookingPdv));
  if(booking)void openTab(booking.id,booking.date);
 });
 $('#pdv-new-product').onclick=()=>openProduct();
 $('#pdv-products').onclick=event=>{
  const button=event.target.closest('[data-pdv-edit-product]');
  const product=button&&dashboard?.products.find(entry=>entry.id===Number(button.dataset.pdvEditProduct));
  if(product)openProduct(product);
 };
 $('#pdv-tab-dismiss').onclick=()=>dialog.close();
 $('#pdv-tab-reload').onclick=()=>{if(!tabBusy&&activeBookingId)void openTab(activeBookingId);};
 dialog.addEventListener('close',()=>{
  if(dialog.open)return;
  tabRequest++;
  activeTab=null;
  activeBookingId=null;
  tabBusy=false;
  addAttempt=null;
  participantAttempt=null;
 });
 detail.addEventListener('submit',event=>{
  if(!activeTab)return;
  event.preventDefault();
  const form=event.target,data=new FormData(form);
  if(form.hasAttribute('data-pdv-add'))void updateTab(path=>sendAdd(path,data),'Item adicionado.');
  if(form.hasAttribute('data-pdv-item')){
   void updateTab(path=>api(path+'/items/'+form.dataset.pdvItem,{
    quantity:Number(data.get('quantity')),participant_id:selectedParticipant(data)
   },'PATCH'),'Item atualizado.');
  }
  if(form.hasAttribute('data-pdv-close')){
   const expected_total_cents=activeTab.consumption_cents;
   void updateTab(path=>api(path+'/close',{method:data.get('method'),expected_total_cents}),'Comanda fechada.');
  }
  if(form.hasAttribute('data-pdv-participant-add')){
   void updateTab(path=>sendParticipant(path,data),'Participante adicionado.');
  }
  if(form.hasAttribute('data-pdv-participant-edit')){
   void updateTab(path=>api(path+'/participants/'+form.dataset.pdvParticipantEdit,participantValues(data),'PATCH'),'Contato atualizado.');
  }
  if(form.hasAttribute('data-pdv-participant-pay')){
   const person=activeTab.participants.find(row=>String(row.id)===form.dataset.pdvParticipantPay);
   if(person)void updateTab(path=>api(`${path}/participants/${person.id}/payment`,{
    method:data.get('method'),expected_cents:person.amount_cents
   }),'Pagamento registrado.');
  }
 });
 detail.onclick=event=>{
  const remove=event.target.closest('[data-pdv-remove]');
  if(remove)void updateTab(path=>api(path+'/items/'+remove.dataset.pdvRemove,{},'DELETE'),'Item removido.');
  const participant=event.target.closest('[data-pdv-remove-participant]');
  if(participant&&!tabBusy&&activeTab){
   const id=Number(participant.dataset.pdvRemoveParticipant);
   const linked=activeTab.items.some(item=>item.participant_id===id);
   if(!linked||window.confirm('Os itens desta pessoa passarão para o consumo compartilhado. Remover participante?')){
    void updateTab(path=>api(path+'/participants/'+id,{},'DELETE'),'Participante removido.');
   }
  }
  if(event.target.closest('[data-pdv-create-product]'))openProduct();
 };

 return {refresh};
})();
