import {parseReceiptAmount} from '../receipt-amount.js';

export function workerReceiptReader({readImage,readPdf}){
 return async(bytes,mime)=>{
  if(!bytes?.length||bytes.length>5*1024*1024)return null;
  try{
   if(mime==='application/pdf'){
    const {amount,images}=await readPdf(bytes);
    if(amount!==null)return amount;
    const text=[];
    for(const image of images)text.push(await readImage(image,'image/png'));
    return parseReceiptAmount(text.join('\n\n'));
   }
   return mime==='image/jpeg'||mime==='image/png'?parseReceiptAmount(await readImage(bytes,mime)):null;
  }catch{
   throw new Error('Leitura automática temporariamente indisponível.');
  }
 };
}
