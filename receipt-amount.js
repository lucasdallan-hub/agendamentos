const amountPattern=/(r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)),(\d{2})(?!\d)/g;
const otherAmount=/\b(?:saldo|tarifa|taxa|limite|juros|encargos|desconto|cashback|troco|multa)\b/;
const feeSuffix=/^\s+de\s+(?:tarifa|taxa|juros|desconto|multa)\b/;
const paymentLabel=/\b(?:valor|total)(?:\s+(?:pago|enviado|transferido|recebido|total|do (?:pix|pagamento)|da (?:transferencia|transacao|operacao|compra)))?\s*[:=]?\s*$/;

// Extract the value from the document alone. The price of the booking must not
// influence which number is selected.
export function receiptAmountCandidates(text){
 if(typeof text!=='string')return new Set();
 const lines=text.slice(0,100_000).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[\u00a0\u202f]/g,' ').toLowerCase().split(/\r?\n/);
 const labelled=new Set(),currency=new Set();
 let previous='';
 for(const line of lines){
  let previousAmountEnd=0;
  for(const match of line.matchAll(amountPattern)){
   const before=line.slice(previousAmountEnd,match.index);
   const after=line.slice(match.index+match[0].length);
   // PDF extractors can put a label or the currency on its own line.
   const context=before.trim()||(previousAmountEnd===0?previous:'');
   previousAmountEnd=match.index+match[0].length;
   if(/[\d.,]$/.test(before)||/^[.,]\d/.test(after)||/[-−]\s*$/.test(before))continue;
   const label=context.replace(/\br\$\s*$/,'').trim();
   if(otherAmount.test(context)||feeSuffix.test(after))continue;
   const cents=Number(match[2].replaceAll('.',''))*100+Number(match[3]);
   if(!Number.isSafeInteger(cents)||cents<=0)continue;
   if(paymentLabel.test(label))labelled.add(cents);
   else if(match[1]||/\br\$$/.test(context.trim()))currency.add(cents);
  }
  if(line.trim())previous=previousAmountEnd===0?line:'';
 }
 return labelled.size?labelled:currency;
}

export function parseReceiptAmount(text){
 const candidates=receiptAmountCandidates(text);
 return candidates.size===1?candidates.values().next().value:null;
}
