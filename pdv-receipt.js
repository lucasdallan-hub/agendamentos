import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';

const money=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const dateTime=new Intl.DateTimeFormat('pt-BR',{
 timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'
});
const formatAmount=cents=>money.format(cents/100).replace(/\u00a0/g,' ');

export async function createPdvReceipt(receipt,arenaName){
 const pdf=await PDFDocument.create();
 const {closure}=receipt;
 const title=closure&&!receipt.amount?'Resumo de fechamento':'Comprovante de pagamento';
 pdf.setTitle(title);
 const extraHeight=closure?100:0;
 const page=pdf.addPage([540,440+extraHeight]);
 const regular=await pdf.embedFont(StandardFonts.Helvetica);
 const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const characters=new Set(regular.getCharacterSet());
 const ink=rgb(0.13,0.20,0.18),muted=rgb(0.30,0.36,0.34);
 function write(value,y,size,font=regular,color=ink){
  const text=Array.from(value.normalize('NFC'),character=>characters.has(character.codePointAt(0))?character:'?').join('');
  const width=font.widthOfTextAtSize(text,size);
  page.drawText(text,{x:40,y,size:width>460?size*460/width:size,font,color});
 }
 const reference=receipt.participantId
  ? `Comanda #${receipt.bookingId} · Subcomanda #${receipt.participantId}`
  : `Comanda #${receipt.bookingId}`;
 write(arenaName,392+extraHeight,13,bold);
 write(title,354+extraHeight,25,bold);
 write(reference,326+extraHeight,13,regular,muted);
 page.drawLine({start:{x:40,y:304+extraHeight},end:{x:500,y:304+extraHeight},thickness:1,color:muted});
 const fields=[
  ['Cliente',receipt.name],
  ...(receipt.court?[['Quadra',receipt.court]]:[]),
  ...(closure?[
   ['Comanda fechada em',dateTime.format(new Date(closure.closedAt))],
   ['Recebido pela quadra',formatAmount(closure.bookingReceived)],
   ['Recebido pelo consumo',formatAmount(closure.consumption)],
   ['Saldo em aberto',formatAmount(closure.pending)]
  ]:[
   ['Recebido em',dateTime.format(new Date(receipt.paidAt))],
   ['Forma de pagamento',receipt.method]
  ])
 ];
 for(const [index,[label,value]] of fields.entries()){
  const y=281+extraHeight-index*46;
  write(label,y,11,bold,muted);
  write(value,y-18,14);
 }
 write('Valor recebido',83,11,bold,muted);
 write(formatAmount(receipt.amount),54,23,bold);
 return pdf.save();
}
