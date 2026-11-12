const $=s=>document.querySelector(s);
let systemBranding={name:'Arena Vôlei',logo:'',is_mother:false},childSystems=[];
let notificationConfig={enabled:false,base_url:'',token_configured:false,target:'arena',arena_number:'',country_code:'55',ready:false},notificationEvents=[];
let courts=[], bookings=[], paymentConfig={ready:false,mode:'test'}, pixSettings={ready:false,ocr_ready:false}, view='overview', setup=false, submitModal;
const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const dateLabel=d=>new Date(d+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'short'});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,body,method='POST') { const r=await fetch('/api/'+url,body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await r.json(); if(!r.ok) { if(r.status===401 && !['login','setup'].includes(url)) await init(); throw Error(data.error); } return data; }
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;setTimeout(()=>$('#toast').hidden=true,4000);}
async function init(){
 const retry=$('#startup-retry');retry.disabled=true;retry.textContent='Conectando…';
 try{
  const [session,identity]=await Promise.all([api('session'),api('system/branding')]);systemBranding=identity;applyBranding();setup=session.setup;
  $('#startup-error').hidden=true;$('#startup-error-message').textContent='';
  $('#auth').hidden=session.authenticated;$('#app').hidden=!session.authenticated;
  $('#auth-description').textContent=setup?'Bem-vindo! Crie a senha do administrador para começar.':'Bem-vindo de volta. Entre para gerenciar sua arena.';
  $('#auth-submit').textContent=setup?'Criar acesso e começar →':'Entrar na arena →';
  $('#auth-form input[name="password"]').minLength=setup?10:1;
  $('#auth-form input[name="password"]').autocomplete=setup?'new-password':'current-password';
  if(session.authenticated)await refresh();
 }catch(e){
  $('#auth').hidden=true;$('#app').hidden=true;$('#startup-error').hidden=false;
  $('#startup-error-message').textContent=e.message||'Não foi possível conectar ao servidor. Tente novamente.';
 }finally{retry.disabled=false;retry.textContent='Tentar novamente';}
}
$('#startup-retry').onclick=()=>init();
$('#auth-form').onsubmit=async e=>{e.preventDefault();$('#auth-error').textContent='';$('#auth-submit').disabled=true;try{await api(setup?'setup':'login',{username:new FormData(e.target).get('username'),password:new FormData(e.target).get('password')});e.target.reset();await init();}catch(e){$('#auth-error').textContent=e.message;}finally{$('#auth-submit').disabled=false;}};
$('#logout').onclick=async()=>{try{await api('logout',{});await init();}catch(e){toast(e.message);}};
async function refresh(){[courts,bookings,paymentConfig,pixSettings,notificationConfig,notificationEvents]=await Promise.all([api('courts'),api('bookings'),api('payments/config'),api('pix/settings'),api('notifications/config'),api('notifications/events')]);await loadSystems();render();}
const stat=(title,value,note,icon)=>`<div class="stat"><div class="stat-top">${title}<span class="stat-icon">${icon}</span></div><strong>${value}</strong><small>${note}</small></div>`;
function receiptLabel(b){
 if(b.receipt_status==='rejected')return 'Comprovante recusado';
 if(b.receipt_status==='pending')return b.receipt_match==='matched'?'Valor compatível · em análise':b.receipt_match==='mismatch'?'Valor divergente · em análise':b.receipt_match==='manual'?'Conferência manual · em análise':'Leitura inconclusiva · em análise';
 return 'Aguardando pagamento';
}
function bookingPaymentLabel(b){
 if(b.status==='cancelled')return 'Cancelado';
 if(b.online_status==='review')return '⚠ Conferir pagamento';
 if(b.online_status==='refunded')return 'Estornado';
 if(b.online_status==='charged_back')return 'Contestado';
 if(b.paid)return '✓ Pago';
 if(b.receipt_status)return receiptLabel(b);
 if(b.online_status==='pending')return 'Em processamento';
 return '◷ Pendente';
}
function bookingActions(b){
 if(b.online_archived)return '<span>Histórico do sistema mãe</span>'+(b.receipt_status?`<button class="table-button" data-receipts="${b.id}">Ver comprovante</button>`:'');
 let html='';
 if(b.status==='confirmed'&&!b.paid&&!b.pix_link&&!['refunded','charged_back','review','creating','unknown'].includes(b.online_status))html+=`<button class="table-button" data-pay="${b.id}">${b.checkout_url?'Ver link':'Mercado Pago'}</button>`;
 if(b.online_status)html+=`<button class="table-button" data-sync="${b.id}">Consultar</button>`;
 if(b.status==='confirmed'&&(!b.online_status||(b.online_status==='failed'&&!b.checkout_url))&&!b.paid)html+=`<button class="table-button" data-pix="${b.id}">${b.pix_link?'Link Pix':'Pix + comprovante'}</button>`;
 if(b.receipt_status)html+=`<button class="table-button" data-receipts="${b.id}">Ver comprovante</button>`;
 if(b.status==='confirmed'&&!b.paid&&!b.online_status&&!b.pix_link)html+=`<button class="table-button cancel" data-cancel="${b.id}">Cancelar</button>`;
 return html||'—';
}
function render(){
 renderNotifications();
 const active=bookings.filter(b=>b.status==='confirmed'), daily=active.filter(b=>b.date===today()), paid=active.filter(b=>b.paid), pending=active.filter(b=>!b.paid&&!['refunded','charged_back','review'].includes(b.online_status));
 document.querySelectorAll('[data-payment-banner]').forEach(el=>{el.classList.toggle('payment-ready',paymentConfig.ready);el.innerHTML=`<div><strong>Mercado Pago · ${paymentConfig.ready?(paymentConfig.mode==='test'?'Modo de teste':'Cobrança online ativa'):'Aguardando ativação'}</strong><p>${paymentConfig.ready?(paymentConfig.mode==='test'?'Links de teste: use contas de teste do Mercado Pago. Não representam recebimentos reais.':'Envie o link ao cliente. A confirmação é consultada diretamente no Mercado Pago.'):'Configure a conta Mercado Pago, a assinatura das notificações e o endereço público para gerar cobranças.'}</p></div><span class="badge ${paymentConfig.ready?'paid':''}">${paymentConfig.ready?'Checkout Pro':'Configuração pendente'}</span>`;});
 $('#financial-connection-description').textContent=paymentConfig.ready?`Conta ${paymentConfig.account_id||'configurada'} · ${paymentConfig.mode==='production'?'Produção':'Teste'} · conexão exclusiva desta arena.`:'Configure as credenciais da conta que receberá os pagamentos desta arena.';
 $('#pix-settings-description').textContent=pixSettings.ready?`Chave cadastrada para ${pixSettings.receiver}.${pixSettings.ocr_ready?' Leitura automática de valores disponível.':' Comprovantes com conferência manual do valor e do crédito na conta.'}`:'Cadastre a chave da arena para que o cliente pague por Pix e envie o comprovante.';
 const sum=a=>a.reduce((s,b)=>s+b.total,0);
 $('#stats').innerHTML=stat('Agendamentos hoje',daily.length,'Reservas confirmadas','▤')+stat('Recebido hoje',money(sum(paid.filter(b=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date(b.paid_at))===today()))),'Pagamentos registrados hoje','↗')+stat('A receber',money(sum(pending)),'Reservas ativas não pagas','◷')+stat('Quadras ativas',courts.filter(c=>c.active).length,'Prontas para receber jogos','▱');
 $('#finance-stats').innerHTML=stat('Total recebido',money(sum(paid)),'Todos os recebimentos','↗')+stat('A receber',money(sum(pending)),'Reservas ativas não pagas','◷')+stat('Pagamentos',paid.length,'Recebimentos confirmados','✓')+stat('Reservas pendentes',pending.length,'Aguardando pagamento','▤');
 const filtered=bookings.filter(b=>(!$('#filter-date').value||b.date===$('#filter-date').value)&&($('#filter-status').value==='all'||($('#filter-status').value==='cancelled'?b.status==='cancelled':b.status==='confirmed'&&Boolean(b.paid)===($('#filter-status').value==='paid'))));
 $('#booking-count').textContent=filtered.length;
 $('#booking-rows').innerHTML=filtered.map(b=>`<tr><td><div class="client"><span class="client-initials">${esc(b.customer.split(' ').map(s=>s[0]).slice(0,2).join('').toUpperCase())}</span><div>${esc(b.customer)}<small>${esc(b.phone)}</small></div></div></td><td>${esc(b.court_name)}<small>${dateLabel(b.date)} · ${esc(b.court_type)}</small></td><td>${b.start} — ${b.end}</td><td>${money(b.total)}</td><td><span class="badge ${b.status==='cancelled'?'cancelled':b.paid?'paid':''}">${bookingPaymentLabel(b)}</span>${b.paid?`<small>${esc(b.method)}</small>`:''}</td><td>${bookingActions(b)}</td></tr>`).join('');
 $('#booking-empty').hidden=filtered.length>0;
 $('#court-list').innerHTML=courts.length?courts.map(c=>`<article class="court-card ${c.active?'':'inactive'}"><div class="court-visual"><div class="court-lines"><div></div></div></div><div class="court-info"><h3>${esc(c.name)}</h3><p>${esc(c.type)}</p><div class="court-price">${money(c.price)} <small>/ hora</small></div><span class="badge ${c.active?'paid':'cancelled'}">${c.active?'● Ativa':'Inativa'}</span><button class="outline" data-toggle="${c.id}">${c.active?'Desativar quadra':'Ativar quadra'}</button></div></article>`).join(''):'<div class="empty"><h3>A sua arena começa aqui</h3><p>Adicione a primeira quadra para criar agendamentos.</p></div>';
 $('#finance-rows').innerHTML=bookings.filter(b=>b.paid||b.online_status||b.pix_link||b.receipt_status).sort((a,b)=>(b.paid_at||b.date).localeCompare(a.paid_at||a.date)).map(b=>`<tr><td>${esc(b.customer)}</td><td>${esc(b.court_name)}</td><td>${b.paid_at?new Date(b.paid_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'—'}</td><td>${esc(b.method||(b.pix_link?'Pix direto':'Mercado Pago'))}</td><td>${money(b.total)}</td><td><span class="badge ${b.paid?'paid':''}">${b.paid?'Pago':bookingPaymentLabel(b)}</span></td></tr>`).join('');$('#finance-empty').hidden=bookings.some(b=>b.paid||b.online_status||b.pix_link||b.receipt_status);
}
const titles={overview:['Tudo pronto para o próximo jogo.','Acompanhe sua arena e mantenha cada reserva em dia.','Visão geral'],bookings:['Cada jogo tem seu horário.','Organize as reservas e acompanhe os pagamentos.','Agendamentos'],courts:['A casa dos próximos jogos.','Gerencie os espaços e valores da sua arena.','Minhas quadras'],systems:['Seu sistema, sua identidade.','Personalize sua arena e gerencie as cópias do sistema mãe.','Meu sistema'],finance:['Suas contas em dia.','Acompanhe os valores recebidos e os pagamentos pendentes.','Financeiro']};
function setView(next){view=next;$('#new-booking').hidden=view==='systems';document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.dataset.view===view));$('#page-title').textContent=titles[view][0];$('#page-subtitle').textContent=titles[view][1];$('#breadcrumb').textContent=titles[view][2];$('#overview-content').hidden=view!=='overview';$('#bookings-content').hidden=!['overview','bookings'].includes(view);$('#courts-content').hidden=view!=='courts';$('#finance-content').hidden=view!=='finance';$('#systems-content').hidden=view!=='systems';$('#filter-date').value=view==='overview'?today():'';$('#list-title').firstChild.textContent=view==='overview'?'Agenda de hoje ':'Agendamentos ';$('#list-description').textContent=view==='overview'?'Confira os horários e prepare a quadra.':'Use os filtros para encontrar uma reserva.';render();}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
$('#today-label').textContent=new Date().toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'long',day:'numeric',month:'long'}).toUpperCase();$('#filter-date').value=today();$('#filter-date').onchange=render;$('#filter-status').onchange=render;
function openModal(title,fields,action,label='Salvar'){$('#modal-fields').onclick=null;$('#modal-fields').onchange=null;$('#modal-title').textContent=title;$('#modal-fields').innerHTML=fields;$('#modal-error').textContent='';$('#save-modal').textContent=label;submitModal=action;$('#modal').showModal();}
$('#close-modal').onclick=$('#cancel-modal').onclick=()=>$('#modal').close();
$('#modal-form').onsubmit=async e=>{e.preventDefault();$('#save-modal').disabled=true;$('#modal-error').textContent='';try{const result=await submitModal(Object.fromEntries(new FormData(e.target)));if(result!==false){$('#modal').close();await refresh();toast('Tudo certo! Alteração salva.');}}catch(e){$('#modal-error').textContent=e.message;}finally{$('#save-modal').disabled=false;}};
function newCourt(){openModal('Adicionar quadra','<label>Nome da quadra<input name="name" placeholder="Ex.: Quadra 01" maxlength="80" required></label><label>Tipo<select name="type"><option>Vôlei de areia</option><option>Vôlei de quadra</option><option>Quadra poliesportiva</option></select></label><label>Valor por hora (R$)<input name="price" type="number" min="1" max="100000" step="0.01" placeholder="120,00" required></label>',data=>api('courts',data),'Cadastrar quadra');}
$('#new-court').onclick=newCourt;
function newBooking(){if(!courts.some(c=>c.active)){setView('courts');newCourt();toast('Cadastre uma quadra ativa para começar.');return;}openModal('Novo agendamento',`<label>Quadra<select name="court_id" id="reserve-court">${courts.filter(c=>c.active).map(c=>`<option value="${c.id}">${esc(c.name)} · ${money(c.price)}/h</option>`).join('')}</select></label><div class="form-row"><label>Nome do cliente<input name="customer" maxlength="120" placeholder="Nome completo" required></label><label>Telefone / WhatsApp<input name="phone" type="tel" maxlength="30" placeholder="(11) 99999-9999" required></label></div><label>Data<input name="date" type="date" value="${today()}" required></label><div class="form-row"><label>Início<input name="start" type="time" id="reserve-start" value="18:00" required></label><label>Fim<input name="end" type="time" id="reserve-end" value="19:00" required></label></div><label>Observações (opcional)<textarea name="notes" maxlength="1000" placeholder="Informações sobre a reserva"></textarea></label><div class="estimate" id="estimate"></div>`,data=>api('bookings',data),'Confirmar agendamento');const estimate=()=>{const c=courts.find(c=>c.id===Number($('#reserve-court').value));const m=t=>Number(t.slice(0,2))*60+Number(t.slice(3));const duration=m($('#reserve-end').value)-m($('#reserve-start').value);$('#estimate').textContent=duration>=30?`Total da reserva: ${money(Math.round(c.price*duration/60))} · pagamento pendente`:'Escolha um intervalo de pelo menos 30 minutos.';};['#reserve-court','#reserve-start','#reserve-end'].forEach(s=>$(s).onchange=estimate);estimate();}
$('#new-booking').onclick=$('#hero-booking').onclick=$('#empty-booking').onclick=newBooking;
function checkoutLink(b,data){
 openModal('Link de pagamento',`<p>Envie este link para <strong>${esc(b.customer)}</strong>. Total: <strong>${money(b.total)}</strong>.</p>${paymentConfig.mode==='test'?'<div class="estimate">MODO DE TESTE · Use apenas contas de teste do Mercado Pago.</div>':''}<label>Link do checkout<input id="checkout-link" readonly value="${esc(data.checkout_url)}"></label><div class="checkout-actions"><button type="button" class="outline" id="copy-link">Copiar link</button><a class="primary checkout-open" href="${esc(data.checkout_url)}" target="_blank" rel="noopener noreferrer">Abrir checkout ↗</a></div><p>Válido até ${new Date(data.expires_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}. A confirmação é automática após aprovação do Mercado Pago.</p><p>Não libere a reserva apenas pelo comprovante ou pelo retorno do navegador.</p>`,async()=>{await refresh();},'Concluir');
 $('#copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(data.checkout_url);toast('Link copiado. Envie ao cliente.');}catch{$('#checkout-link').select();toast('Selecione e copie o link para enviar ao cliente.');}};
}
function onlinePayment(b){
 if(!paymentConfig.ready){openModal('Ative a cobrança online','<p>A arena ainda não está conectada ao Mercado Pago. Configure a conta recebedora, a assinatura das notificações e o endereço público da aplicação antes de gerar links.</p><p>Nenhuma cobrança foi criada.</p>',async()=>{},'Entendi');return;}
 if(b.checkout_url){
  if(new Date(b.expires_at)<=new Date()){openModal('Link de pagamento expirado','<p>Este link expirou. Consulte o status e verifique a cobrança no Mercado Pago antes de tomar outra ação.</p>',async()=>{await api(`bookings/${b.id}/sync-payment`,{});},'Consultar pagamento');return;}
  checkoutLink(b,b);return;
 }
 openModal('Cobrar com Mercado Pago',`<p>Gere um link para <strong>${esc(b.customer)}</strong> pagar <strong>${money(b.total)}</strong> pela reserva de ${esc(b.court_name)}.</p><div class="estimate">${paymentConfig.mode==='test'?'Modo de teste: não use pagamentos reais.':'O cliente escolhe uma das formas habilitadas na sua conta Mercado Pago, como Pix ou cartão.'}</div><p>O link vale por 24 horas. O horário fica reservado enquanto o pagamento é acompanhado. Reservas com cobrança online devem ser tratadas pelo Mercado Pago para cancelamentos e estornos.</p>`,async()=>{const data=await api(`bookings/${b.id}/checkout`,{});await refresh();checkoutLink(b,data);return false;},'Gerar link de pagamento');
}
$('#booking-rows').onclick=async e=>{
 const pay=e.target.closest('[data-pay]'),cancel=e.target.closest('[data-cancel]'),sync=e.target.closest('[data-sync]'),pix=e.target.closest('[data-pix]'),receipts=e.target.closest('[data-receipts]');
 if(pix)openPix(bookings.find(b=>b.id===Number(pix.dataset.pix)));
 if(receipts){receipts.disabled=true;try{await showReceipts(bookings.find(b=>b.id===Number(receipts.dataset.receipts)));}catch(e){toast(e.message);}finally{receipts.disabled=false;}}
 if(pay)onlinePayment(bookings.find(b=>b.id===Number(pay.dataset.pay)));
 if(sync){sync.disabled=true;try{await api(`bookings/${sync.dataset.sync}/sync-payment`,{});await refresh();toast('Status consultado no Mercado Pago.');}catch(e){toast(e.message);}finally{sync.disabled=false;}}
 if(cancel){const b=bookings.find(b=>b.id===Number(cancel.dataset.cancel));openModal('Cancelar agendamento',`<p>Cancelar a reserva de <strong>${esc(b.customer)}</strong> em ${dateLabel(b.date)}, às ${b.start}? O horário ficará disponível para uma nova reserva.</p>`,()=>api(`bookings/${b.id}/cancel`,{}),'Cancelar agendamento');}
};
function configurePix(afterSave){
 openModal('Chave Pix da arena',`<p>Informe uma chave Pix da conta que recebe os pagamentos e o nome do favorecido. O cliente deve conferir o destinatário no aplicativo do banco.</p><label>Chave Pix<input name="key" value="${esc(pixSettings.key||'')}" maxlength="140" placeholder="E-mail, telefone, CPF/CNPJ ou chave aleatória" required></label><label>Nome do favorecido<input name="receiver" value="${esc(pixSettings.receiver||'')}" maxlength="120" placeholder="Nome do titular da conta" required></label>`,async data=>{await api('pix/settings',data,'PUT');await refresh();if(afterSave){afterSave();return false;}},'Salvar chave Pix');
}
$('#configure-pix').onclick=()=>configurePix();
function pixLinkModal(b,data){
 const link=new URL(data.path,location.origin).href;
 openModal('Enviar pagamento Pix',`<p>Compartilhe este link com <strong>${esc(b.customer)}</strong> para pagar <strong>${money(b.total)}</strong> por Pix e enviar o comprovante.</p><label>Link para o cliente<input id="pix-payment-link" value="${esc(link)}" readonly></label><div class="checkout-actions"><button type="button" class="outline" id="copy-pix-link">Copiar link</button><a class="primary checkout-open" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Abrir página Pix ↗</a></div><p>Válido até ${new Date(data.expires_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}. O sistema lê o valor do comprovante; o recebimento será conferido pelo administrador.</p>`,async()=>{},'Concluir');
 $('#copy-pix-link').onclick=async()=>{try{await navigator.clipboard.writeText(link);toast('Link Pix copiado.');}catch{$('#pix-payment-link').select();toast('Selecione e copie o link Pix.');}};
}
function openPix(b){
 if(!pixSettings.ready){configurePix(()=>openPix(b));return;}
 openModal('Pix com comprovante',`<p>O cliente receberá a chave Pix de <strong>${esc(pixSettings.receiver)}</strong> e o valor de <strong>${money(b.total)}</strong>, com espaço para enviar o comprovante.</p><div class="estimate">O valor será lido automaticamente e comparado com a reserva. A reserva só ficará paga depois da confirmação de recebimento pelo administrador.</div>`,async()=>{const data=await api(`bookings/${b.id}/pix-link`,{});await refresh();pixLinkModal(b,data);return false;},b.pix_link?'Mostrar link Pix':'Gerar link Pix');
}
async function showReceipts(b){
 const receipts=await api(`bookings/${b.id}/receipts`);
 const labels={manual:'Conferência manual necessária',matched:'Valor compatível',mismatch:'Valor divergente',unreadable:'Leitura inconclusiva'};
 const statusLabels={pending:'Aguardando conferência',approved:'Aprovado',rejected:'Recusado'};
 openModal('Conferir comprovante Pix',`<p>Reserva de <strong>${esc(b.customer)}</strong> · valor esperado <strong>${money(b.total)}</strong>.</p><p>Abra o original e confira o crédito na conta antes de aprovar. A leitura do arquivo não confirma a transferência bancária.</p>${receipts.length?receipts.map(r=>`<article class="receipt-card"><div class="receipt-heading"><strong>${esc(r.filename)}</strong><span class="badge ${r.status==='approved'?'paid':''}">${statusLabels[r.status]||'Em análise'}</span></div><p>${new Date(r.created_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</p><div class="receipt-values"><span>Esperado<strong>${money(b.total)}</strong></span><span>Identificado<strong>${r.amount_cents===null?'Não identificado':money(r.amount_cents)}</strong></span></div><p class="receipt-match ${r.match_status==='matched'?'is-matched':'is-warning'}">${labels[r.match_status]||'Leitura inconclusiva'}</p><a class="receipt-original" href="/api/receipts/${r.id}/file" target="_blank" rel="noopener noreferrer">Abrir comprovante original ↗</a>${r.review_note?`<p>Observação: ${esc(r.review_note)}</p>`:''}${r.status==='pending'?`<label>Observação da conferência<textarea data-review-note="${r.id}" maxlength="1000" placeholder="Motivo da recusa ou observação (opcional)"></textarea></label>${(r.match_status==='matched'||pixSettings.manual_review)?`${pixSettings.manual_review?`<label>Valor recebido (R$)<input type="number" min="0.01" step="0.01" data-received-amount="${r.id}" placeholder="0,00"></label>`:''}<label class="check-label"><input type="checkbox" data-confirm-receipt="${r.id}"> Conferi o recebimento na conta</label>`:'<p>Peça um novo comprovante legível e com o valor correto antes de aprovar.</p>'}<div class="receipt-actions">${(r.match_status==='matched'||pixSettings.manual_review)?`<button type="button" class="primary" data-approve-receipt="${r.id}" disabled>Confirmar recebimento</button>`:''}<button type="button" class="outline" data-reject-receipt="${r.id}">Recusar comprovante</button></div>`:''}</article>`).join(''):'<p>Nenhum comprovante enviado para esta reserva.</p>'}`,async()=>{},'Fechar');
 $('#modal-fields').onchange=e=>{const checkbox=e.target.closest('[data-confirm-receipt]');if(checkbox)$(`[data-approve-receipt="${checkbox.dataset.confirmReceipt}"]`).disabled=!checkbox.checked;};
 $('#modal-fields').onclick=async e=>{
 const button=e.target.closest('[data-approve-receipt],[data-reject-receipt]');if(!button)return;
 const id=button.dataset.approveReceipt||button.dataset.rejectReceipt,approve=!!button.dataset.approveReceipt;
 const confirmed=$(`[data-confirm-receipt="${id}"]`)?.checked===true;
 if(approve&&!confirmed){$('#modal-error').textContent='Confira o recebimento na conta e marque a confirmação.';return;}
 const buttons=[...$('#modal-fields').querySelectorAll('button')];buttons.forEach(el=>el.disabled=true);$('#modal-error').textContent='';
 try{await api(`receipts/${id}/review`,{decision:approve?'approve':'reject',note:$(`[data-review-note="${id}"]`)?.value||'',confirmed_received:approve&&confirmed,confirmed_amount_cents:Math.round(Number($(`[data-received-amount="${id}"]`)?.value)*100)});await refresh();await showReceipts(bookings.find(row=>row.id===b.id)||b);toast(approve?'Recebimento confirmado pelo administrador.':'Comprovante recusado. O cliente pode enviar outro.');}catch(e){$('#modal-error').textContent=e.message;buttons.forEach(el=>el.disabled=false);}
 };
}
$('#court-list').onclick=e=>{const btn=e.target.closest('[data-toggle]');if(!btn)return;const c=courts.find(c=>c.id===Number(btn.dataset.toggle));openModal(c.active?'Desativar quadra':'Ativar quadra',`<p>${c.active?'A quadra deixará de aceitar novas reservas. Os agendamentos existentes serão preservados.':'A quadra voltará a aceitar agendamentos.'}</p>`,()=>api(`courts/${c.id}`,{active:!c.active},'PATCH'),'Confirmar');};

function applyBranding(){
 document.title=systemBranding.name+' · Gestão de quadras';
 for(const element of [$('.logo'),$('#auth .brand-icon')]){
  element.replaceChildren();
  if(systemBranding.logo){const img=document.createElement('img');img.src=systemBranding.logo;img.alt='Logo de '+systemBranding.name;img.className='system-logo';element.append(img);}
  const name=document.createElement('span');name.textContent=systemBranding.name;element.append(name);
 }
 $('#auth h1').textContent=systemBranding.name;
 $('footer span').textContent=systemBranding.name;
 $('#system-name').textContent=systemBranding.name;
 $('#child-domain-section').hidden=systemBranding.is_mother;
 $('#child-domain-name').textContent=location.hostname;
 $('#children-section').hidden=!systemBranding.is_mother||!systemBranding.systems_available;
}
async function loadSystems(){
 childSystems=systemBranding.is_mother&&systemBranding.systems_available?await api('systems'):[];
 $('#children-list').innerHTML=childSystems.length?childSystems.map(system=>`<article class="court-card"><div class="court-info"><h3>${esc(system.name)}</h3><p>${esc(system.hostname)}</p><span class="badge">${system.status==='ready'?'Cópia criada':'Cópia pendente'}</span><p>Dados copiados em ${new Date(system.created_at).toLocaleString('pt-BR')}</p>${system.status==='ready'?`<a class="outline" href="https://${esc(system.hostname)}" target="_blank" rel="noopener noreferrer">Abrir sistema ↗</a>`:''}<p>O acesso depende do DNS e HTTPS configurados na Cloudflare.</p></div></article>`).join(''):'<p>Nenhum sistema filho criado.</p>';
}
function renderNotifications(){
 $('#notifications-description').textContent=notificationConfig.enabled?(notificationConfig.ready?`Envio habilitado para o administrador no número ${notificationConfig.arena_number||'cadastrado'}. Verifique a conexão para confirmar a sessão do WhatsApp.`:'Envio habilitado, mas a configuração ainda está incompleta.'):'Envio desativado. Configure a Evolution Go desta arena para avisar sobre novos agendamentos.';
 $('#check-notifications').disabled=!notificationConfig.ready;
 const labels={pending:'Aguardando envio',sending:'Envio em andamento',accepted:'Aceita pela API',failed:'Falha no envio',unknown:'Resultado incerto'};
 $('#notifications-rows').innerHTML=notificationEvents.map(event=>`<tr><td>#${esc(event.booking_id)}</td><td>Administrador<small>${esc(event.recipient)}</small></td><td><span class="badge ${event.status==='accepted'?'paid':event.status==='failed'?'cancelled':''}">${labels[event.status]||'Status desconhecido'}</span></td><td>${new Date(event.updated_at||event.created_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</td><td>${esc(event.error|| (event.status==='unknown'?'Confira a Evolution Go antes de enviar novamente.':event.status==='accepted'?'A entrega no WhatsApp ainda não foi confirmada.':''))}</td></tr>`).join('');
 $('#notifications-empty').hidden=notificationEvents.length>0;
}
$('#configure-notifications').onclick=()=>{
 openModal('WhatsApp do administrador',`<p>Conexão exclusiva desta arena. Use a URL HTTPS da sua Evolution Go e o token da instância conectada ao WhatsApp.</p><label class="check-label"><input id="notifications-enabled" name="enabled" type="checkbox" ${notificationConfig.enabled?'checked':''}> Avisar o administrador sobre novos agendamentos</label><label>URL HTTPS da Evolution Go<input id="notifications-url" name="base_url" type="url" value="${esc(notificationConfig.base_url||'')}" maxlength="2000" placeholder="https://whatsapp.seudominio.com.br"></label><label>Token da instância<input id="notifications-api-key" name="api_key" type="password" autocomplete="new-password" maxlength="2000" placeholder="${notificationConfig.token_configured?'Já configurado; deixe vazio para manter':'Token da instância, não a chave administrativa global'}"></label><label>WhatsApp do administrador<input id="notifications-arena-number" name="arena_number" type="tel" maxlength="30" value="${esc(notificationConfig.arena_number||'')}" placeholder="55 11 99999-9999"></label><label>Código do país para números locais<input id="notifications-country-code" name="country_code" inputmode="numeric" maxlength="3" value="${esc(notificationConfig.country_code||'55')}"></label><p>Salvar a configuração não envia uma mensagem. Apenas novos agendamentos geram avisos; uma falha no WhatsApp não cancela a reserva. A chave não será exibida novamente nem copiada para sistemas filhos.</p>`,async data=>{
  notificationConfig=await api('notifications/config',{...data,enabled:data.enabled==='on',target:'arena'},'PUT');
  $('#notifications-connection').textContent='Configuração salva. Use Verificar conexão para consultar a sessão do WhatsApp.';
 });
 const requirements=()=>{const enabled=$('#notifications-enabled').checked;$('#notifications-url').required=enabled;$('#notifications-api-key').required=enabled&&!notificationConfig.token_configured;$('#notifications-arena-number').required=enabled;$('#notifications-country-code').required=enabled;};
 $('#modal-fields').onchange=requirements;requirements();
};
$('#check-notifications').onclick=async()=>{
 const button=$('#check-notifications');button.disabled=true;$('#notifications-connection').textContent='Consultando a sessão do WhatsApp…';
 try{const result=await api('notifications/check',{});$('#notifications-connection').textContent=result.connected&&result.logged_in?'WhatsApp conectado à Evolution Go. A entrega de cada aviso depende do processamento da mensagem.':'A Evolution Go respondeu, mas a sessão do WhatsApp precisa ser conectada.';}
 catch(error){$('#notifications-connection').textContent=error.message;}
 finally{button.disabled=!notificationConfig.ready;}
};
$('#configure-catalog').onclick=async()=>{
 try{const config=await api('catalog/settings');openModal('Catálogo e agendamento online',`<p>Divulgue <a href="/catalogo" target="_blank" rel="noopener noreferrer">${esc(location.origin)}/catalogo</a> para seus clientes reservarem diretamente.</p><label class="check-label"><input name="enabled" type="checkbox" ${config.enabled?'checked':''}> Aceitar reservas pelo catálogo</label><label>Abertura<input name="open" type="time" step="1800" value="${esc(config.open)}" required></label><label>Fechamento<input name="close" type="time" step="1800" value="${esc(config.close)}" required></label><p>Reservas de 30 minutos a 4 horas, até 180 dias à frente. O pagamento é confirmado separadamente.</p>`,data=>api('catalog/settings',{...data,enabled:data.enabled==='on'},'PUT'));}catch(error){toast(error.message);}
};
$('#configure-financial').onclick=()=>openModal('Conectar Mercado Pago desta arena',`<p>Use as credenciais da aplicação Mercado Pago desta arena. Elas não serão compartilhadas com a mãe ou com outros filhos.</p><label>Ambiente<select name="mode"><option value="test" ${paymentConfig.mode==='test'?'selected':''}>Teste</option><option value="production" ${paymentConfig.mode==='production'?'selected':''}>Produção</option></select></label><label>Endereço público HTTPS<input name="base_url" type="url" value="${esc(paymentConfig.base_url||location.origin)}" required></label><label>Access Token<input name="token" type="password" autocomplete="new-password" maxlength="2000" placeholder="${paymentConfig.token_configured?'Já configurado; deixe vazio para manter':'Token da aplicação desta arena'}" ${paymentConfig.token_configured?'':'required'}></label><label>Segredo de assinatura do webhook<input name="webhook_secret" type="password" autocomplete="new-password" maxlength="2000" placeholder="${paymentConfig.webhook_configured?'Já configurado; deixe vazio para manter':'Segredo do webhook desta aplicação'}" ${paymentConfig.webhook_configured?'':'required'}></label><p>Configure no Mercado Pago notificações de Pagamentos para <strong>${esc(paymentConfig.base_url||location.origin)}/api/payments/webhook</strong>. O sistema verificará a conta antes de salvar. Os campos secretos nunca são devolvidos ao navegador.</p>`,data=>api('payments/config',data,'PUT'),'Salvar e verificar conta');
$('#edit-branding').onclick=()=>{
 openModal('Nome e logo do sistema',`<label>Nome<input name="name" value="${esc(systemBranding.name)}" maxlength="80" required></label><label>Logo PNG ou JPEG (até 250 KB)<input id="system-logo-file" type="file" accept="image/png,image/jpeg"></label><label class="check-label"><input name="remove_logo" type="checkbox"> Remover logo atual</label>`,async data=>{
  let logo=data.remove_logo?'':systemBranding.logo;const file=$('#system-logo-file').files[0];
  if(file){if(file.size>250*1024)throw Error('A logo deve ter até 250 KB.');logo=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Não foi possível ler a logo.'));reader.readAsDataURL(file);});}
  systemBranding=await api('system/branding',{name:data.name,logo},'PUT');applyBranding();
 });
};
$('#edit-domain').onclick=()=>openModal('Alterar subdomínio',`<p>O endereço atual deixará de apontar para este filho. Configure o DNS e HTTPS do novo endereço na Cloudflare antes de salvar. Será necessário entrar novamente no novo endereço.</p><label>Novo subdomínio<input name="hostname" placeholder="unidade.seudominio.com.br" required></label>`,async data=>{const result=await api('system/domain',data,'PUT');location.assign(result.url);return false;});
$('#new-system').onclick=()=>openModal('Criar sistema filho',`<p>Serão copiados quadras, reservas, configurações Pix, comprovantes e histórico financeiro. A cópia é independente; mudanças futuras não são sincronizadas. Sessões, senhas e credenciais Mercado Pago ou Evolution Go não são copiadas.</p><label>Nome do sistema<input name="name" maxlength="80" required></label><label>Identificador<input name="slug" pattern="[a-z0-9][a-z0-9-]{0,39}" maxlength="40" placeholder="arena-centro" required></label><label>Subdomínio completo<input name="hostname" placeholder="centro.seudominio.com.br" maxlength="253" required></label><label>Senha do administrador do filho<input name="password" type="password" minlength="10" maxlength="200" autocomplete="new-password" required></label><p>Usuário do filho: admin. Conecte o subdomínio ao mesmo Worker na Cloudflare após criar a cópia.</p>`,data=>api('systems',data),'Criar cópia completa');
init();
setInterval(()=>{if(!$('#app').hidden&&!document.hidden)refresh().catch(e=>toast(e.message));},30000);
