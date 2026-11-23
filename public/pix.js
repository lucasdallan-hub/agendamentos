const $=selector=>document.querySelector(selector);
const token=location.hash.slice(1);
const money=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let current,refreshTimer,uploading=false,loading=false;
const endpoint='/api/pix/payments/'+encodeURIComponent(token);
async function request(url,body){
 const response=await fetch(url,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let data;try{data=await response.json();}catch{throw Error('Não foi possível ler a resposta da arena. Tente novamente.');}
 if(!response.ok)throw Error(data.error||'Não foi possível concluir esta operação.');
 return data;
}
function toast(message){$('#pix-toast').textContent=message;$('#pix-toast').hidden=false;setTimeout(()=>$('#pix-toast').hidden=true,4500);}
function renderReceipt(receipt){
 const box=$('#pix-receipt-result');
 box.hidden=!receipt;if(!receipt)return;
 const approved=receipt.status==='approved',rejected=receipt.status==='rejected';
 const reading={
  processing:'Lendo o comprovante…',
  exact:'Valor igual ao da reserva',matched:'Valor igual ao da reserva',
  different:'Valor diferente da reserva',mismatch:'Valor diferente da reserva',
  unreadable:'Valor não identificado',
  manual:'Aguardando conferência'
 };
 const title=approved?'Comprovante aprovado':rejected?'Comprovante recusado':reading[receipt.match_status]||reading.manual;
 const description=approved?'A arena confirmou o recebimento.':rejected?'Envie outro comprovante legível do Pix com o valor exato da reserva.':'Aguardando a conferência do crédito na conta da arena.';
 box.className=approved?'pix-receipt-result pix-approved':'pix-receipt-result';
 box.innerHTML=`<strong>${title}</strong><p>${description}</p>${receipt.review_note?`<p>Observação da arena: ${escape(receipt.review_note)}</p>`:''}`;
}
function render(){
 $('#pix-loading').hidden=true;$('#pix-error-card').hidden=true;$('#pix-content').hidden=false;
 $('#pix-total').textContent=money(current.total);$('#pix-reservation').textContent=`${current.customer}, confira os dados e garanta o seu próximo jogo.`;
 $('#pix-booking-detail').textContent=`${current.court_name} · ${new Date(current.date+'T12:00:00').toLocaleDateString('pt-BR')} · ${current.start}–${current.end}`;
 $('#pix-key').value=current.key;$('#pix-receiver').textContent=current.receiver;
 const paid=Boolean(current.paid),pending=current.receipt?.status==='pending';
 $('#pix-transfer-section').hidden=paid;$('#pix-paid-section').hidden=!paid;
 $('#pix-upload-form').hidden=paid||pending;
 $('#pix-ocr-detail').hidden=!current.ocr_ready||!!current.receipt;
 $('#pix-receipt-disclaimer').hidden=paid||pending;
 renderReceipt(current.receipt);
}
function scheduleLoad(){
 clearTimeout(refreshTimer);
 if(document.hidden)return;
 const reading=current?.receipt?.status==='pending'&&current.receipt.match_status==='processing';
 refreshTimer=setTimeout(load,reading?3000:15000);
}
async function load(initial=false){
 if(loading||uploading)return;loading=true;
 if(initial){$('#pix-loading').hidden=false;$('#pix-error-card').hidden=true;}
 try{
  if(!token||token.length>300)throw Error('O link está incompleto ou inválido.');
  current=await request(endpoint);render();
 }catch(error){
  if(initial||!current){$('#pix-loading').hidden=true;$('#pix-content').hidden=true;$('#pix-error-card').hidden=false;$('#pix-load-error').textContent=error.message;}
  else toast(error.message);
 }finally{loading=false;scheduleLoad();}
}
$('#pix-copy-key').onclick=async()=>{try{await navigator.clipboard.writeText(current.key);toast('Chave Pix copiada. Cole no aplicativo do seu banco.');}catch{$('#pix-key').select();toast('Selecione e copie a chave Pix para usar no seu banco.');}};
$('#pix-retry').onclick=()=>load(true);
$('#pix-file').onchange=()=>{$('#pix-upload-error').textContent='';const file=$('#pix-file').files[0];$('#pix-selected-file').textContent=file?`${file.name} · ${(file.size/1024/1024).toFixed(2)} MB`:'';};
$('#pix-upload-form').onsubmit=async event=>{
 event.preventDefault();if(uploading)return;
 const file=$('#pix-file').files[0];$('#pix-upload-error').textContent='';
 if(!file){$('#pix-upload-error').textContent='Selecione um comprovante para continuar.';return;}
 if(file.size>5*1024*1024){$('#pix-upload-error').textContent='O comprovante deve ter até 5 MB.';return;}
 if(!/\.(png|jpe?g|pdf)$/i.test(file.name)){ $('#pix-upload-error').textContent='Envie uma imagem PNG, JPG ou um arquivo PDF.';return; }
 uploading=true;$('#pix-submit').disabled=true;$('#pix-file').disabled=true;
 const progress=$('#pix-upload-progress');
 progress.hidden=false;
 try{
  const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Não foi possível abrir o arquivo selecionado.'));reader.readAsDataURL(file);});
  const receipt=await request(endpoint+'/receipt',{filename:file.name,content_base64:content});
  $('#pix-upload-form').reset();$('#pix-selected-file').textContent='';
  current={...current,receipt};render();toast('Comprovante enviado para conferência.');
 }catch(error){$('#pix-upload-error').textContent=error.message;}
 finally{uploading=false;$('#pix-submit').disabled=false;$('#pix-file').disabled=false;progress.hidden=true;scheduleLoad();}
};
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(refreshTimer);else void load();});
load(true);
