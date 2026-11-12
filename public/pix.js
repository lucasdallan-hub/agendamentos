const $=selector=>document.querySelector(selector);
const token=location.hash.slice(1);
const money=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let current,uploading=false,loading=false;
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
 const matched=receipt.match_status==='matched';
 const title=receipt.status==='approved'?'Comprovante aprovado':receipt.status==='rejected'?'Comprovante recusado':receipt.match_status==='manual'?'Aguardando conferência da arena':matched?'Valor compatível · em análise':receipt.match_status==='mismatch'?'Valor diferente da reserva':'Não foi possível identificar um valor único';
 const description=receipt.status==='approved'?'O administrador confirmou o recebimento.':receipt.status==='rejected'?'Envie outro comprovante legível do Pix com o valor exato da reserva.':receipt.match_status==='manual'?'A arena conferirá o comprovante e o crédito na conta antes de confirmar o pagamento.':matched?'Comprovante enviado. Aguardando confirmação do administrador.':receipt.match_status==='mismatch'?'O valor lido não corresponde à reserva. Aguarde a conferência da arena; ela poderá solicitar um novo comprovante.':'O arquivo foi enviado para conferência. A arena poderá solicitar um comprovante mais legível.';
 box.className='pix-receipt-result '+(matched?'pix-match':'pix-review');
 box.innerHTML=`<strong>${title}</strong><div class="receipt-values"><span>Valor da reserva<strong>${money(current.total)}</strong></span><span>Valor identificado<strong>${receipt.amount_cents===null?'Não identificado':money(receipt.amount_cents)}</strong></span></div><p>${description}</p>${receipt.review_note?`<p>Observação da arena: ${escape(receipt.review_note)}</p>`:''}`;
}
function render(){
 $('#pix-loading').hidden=true;$('#pix-error-card').hidden=true;$('#pix-content').hidden=false;
 $('#pix-total').textContent=money(current.total);$('#pix-reservation').textContent=`${current.customer}, confira os dados e garanta o seu próximo jogo.`;
 $('#pix-booking-detail').textContent=`${current.court_name} · ${new Date(current.date+'T12:00:00').toLocaleDateString('pt-BR')} · ${current.start}–${current.end}`;
 $('#pix-key').value=current.key;$('#pix-receiver').textContent=current.receiver;
 const paid=Boolean(current.paid),pending=current.receipt?.status==='pending';
 $('#pix-transfer-section').hidden=paid;$('#pix-paid-section').hidden=!paid;
 $('#pix-upload-form').hidden=paid||pending;
 renderReceipt(current.receipt);
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
 }finally{loading=false;}
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
 uploading=true;$('#pix-submit').disabled=true;$('#pix-file').disabled=true;$('#pix-upload-progress').hidden=false;
 try{
  const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Não foi possível abrir o arquivo selecionado.'));reader.readAsDataURL(file);});
  await request(endpoint+'/receipt',{filename:file.name,content_base64:content});
  $('#pix-upload-form').reset();$('#pix-selected-file').textContent='';
  current=await request(endpoint);render();toast('Comprovante enviado para conferência.');
 }catch(error){$('#pix-upload-error').textContent=error.message;}
 finally{uploading=false;$('#pix-submit').disabled=false;$('#pix-file').disabled=false;$('#pix-upload-progress').hidden=true;}
};
load(true);
setInterval(()=>{if(!document.hidden)load();},15000);
