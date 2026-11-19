// Transport for configured OCR. Only the receipt bytes and MIME type cross the boundary.
const unavailable=()=>Object.assign(new Error('O leitor de comprovantes está temporariamente indisponível.'),{status:503});

export function workerReceiptReader(env,fetchImpl=fetch){
 const token=env.RECEIPT_OCR_TOKEN;
 if(typeof token!=='string'||!token||/[\s\x00-\x1f\x7f]/.test(token)||typeof env.RECEIPT_OCR_URL!=='string')return null;
 let origin;
 try{origin=new URL(env.RECEIPT_OCR_URL);}catch{return null;}
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)return null;
 const url=origin.origin+'/read';
 return async(buffer,mime)=>{
  let response;
  try{
   response=await fetchImpl(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':mime},body:buffer,redirect:'manual',signal:AbortSignal.timeout(65_000)});
  }catch{throw unavailable();}
  if(response.status===422)return {amount_cents:null};
  if(!response.ok)throw unavailable();
  const result=await response.json().catch(()=>null);
  const amount=result?.amount_cents;
  if(amount!==null&&(!Number.isSafeInteger(amount)||amount<=0))throw unavailable();
  return {amount_cents:amount};
 };
}
