import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';

const apiOrigin = 'https://api.misticpay.com/api/transactions';
const responseLimit = 300_000;
const states = new Set(['PENDENTE','COMPLETO','FALHA','CANCELADO','DEVOLVIDO','DEVOLVIDO_PARCIAL']);
const definitiveErrors = new Map([
 ['INVALID_API_CREDENTIAL',401],['IP_NOT_ALLOWED',401],['API_SCOPE_DENIED',403],
 ['API_CREDENTIAL_REQUIRED',400],['INVALID_JSON',400],['VALIDATION_ERROR',400],['AMOUNT_BELOW_MINIMUM',400]
]);
const diagnosticCodes = new Set([
 ...definitiveErrors.keys(),'TRANSACTION_NOT_FOUND','ROUTE_NOT_FOUND','RATE_LIMITED','RATE_LIMIT','INTERNAL_ERROR'
]);
const missingTransactionMessages = new Set([
 'transacao nao encontrada','transacao nao localizada','transaction not found',
 'nenhuma transacao com o identificador informado'
]);
const missingMessage = 'A transação Pix não foi encontrada na conta MisticPay. Confira o identificador informado.';
const diagnostics = new WeakMap();
export const transactionIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function missingTransaction(status, data) {
 if(status!==404&&status!==400)return false;
 if(data?.statusCode!==undefined&&data.statusCode!==status)return false;
 if(data?.code==='TRANSACTION_NOT_FOUND')return true;
 if(data?.code!=null&&!(status===404&&data.code==='INTERNAL_ERROR'))return false;
 if(typeof data?.message!=='string'||data.message.length>80)return false;
 const message = data.message.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/[.!]+$/,'');
 return missingTransactionMessages.has(message);
}

function providerMessage(status, code, action) {
 if(code==='INTERNAL_ERROR'||status>=500){
  return 'A MisticPay informou uma falha interna. Tente novamente ou informe a referência ao suporte do provedor.';
 }
 if(status===400){
  if(code==='API_CREDENTIAL_REQUIRED')return 'A MisticPay não reconheceu as credenciais enviadas. Use o Client ID pk_ e o Client Secret sk_ da mesma chave de acesso.';
  if(code==='AMOUNT_BELOW_MINIMUM')return 'O valor está abaixo do mínimo aceito pela MisticPay.';
  return 'A MisticPay recusou os dados enviados. Confira as informações da solicitação.';
 }
 if(status===401){
  if(code==='IP_NOT_ALLOWED')return 'A MisticPay bloqueou o IP de saída do servidor. Confira a lista de IPs autorizados na conta MisticPay.';
  return 'Client ID ou Client Secret inválido ou revogado. Confira o par ativo em API → Chaves de Acesso da MisticPay.';
 }
 if(status===403){
  const scope = action==='check'?'TRANSACTION_READ':'TRANSACTION_CREATE';
  return `A MisticPay recusou o acesso. Confira a permissão ${scope} na chave de acesso.`;
 }
 if(status===404){
  if(code==='TRANSACTION_NOT_FOUND')return missingMessage;
  if(code==='ROUTE_NOT_FOUND')return 'A rota da MisticPay não está disponível para esta solicitação.';
 }
 if(status===429)return 'A MisticPay limitou as requisições. Aguarde um momento e tente novamente.';
 return 'A MisticPay recusou a solicitação. Use o código e a referência para consultar o suporte do provedor.';
}

function raiseFailure({message, action, providerStatus, providerCode, requestId, definitive=false}) {
 const error = Object.assign(new Error(message), {status:502,providerStatus,providerCode,requestId,definitive});
 diagnostics.set(error, {message,http_status:providerStatus??null,code:providerCode??null,request_id:requestId??null});
 console.warn('MisticPay', misticpayDiagnostic(error, `transactions/${action}`));
 throw error;
}

export function misticpayDiagnostic(error, operation, checkedAt=Date.now()) {
 const orderMismatch = error?.diagnosticCode==='ORDER_MISMATCH';
 const diagnostic = diagnostics.get(error)??{
  message:orderMismatch
   ?'As novas chaves precisam dar acesso às cobranças já criadas nesta arena.'
   :'Não foi possível verificar a resposta da MisticPay.',
  http_status:null,
  code:orderMismatch?'ORDER_MISMATCH':null,
  request_id:null
 };
 return {...diagnostic,operation,checked_at:new Date(checkedAt).toISOString()};
}

async function readJson(response) {
 if(!response.body||Number(response.headers.get('content-length'))>responseLimit)throw new Error();
 const chunks = [];
 let size = 0;
 for await(const chunk of response.body){
  size+=chunk.byteLength;
  if(size>responseLimit)throw new Error();
  chunks.push(chunk);
 }
 const data = JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();
 return data;
}

export async function requestMisticPay(fetchImpl, credentials, action, body, {requireExisting=false,decode}={}) {
 const requestId = randomUUID();
 const signal = AbortSignal.timeout(12_000);
 let providerStatus, response, data;
 try {
  response = await fetchImpl(`${apiOrigin}/${action}`, {
   method:'POST',redirect:'manual',signal,
   headers:{
    Authorization:'Basic '+Buffer.from(`${credentials.public_key}:${credentials.secret_key}`,'utf8').toString('base64'),
    'Content-Type':'application/json',
    'X-Request-Id':requestId
   },
   body:JSON.stringify(body)
  });
  providerStatus = response.status;
  data = await readJson(response);
 } catch(error) {
  const timeout = signal.aborted||error?.name==='TimeoutError'||error?.name==='AbortError';
  const providerCode = timeout?'TIMEOUT':providerStatus?'INVALID_RESPONSE':'NETWORK_ERROR';
  const message = timeout?'A solicitação à MisticPay excedeu o tempo limite. Tente novamente.':
   providerStatus?'A MisticPay retornou uma resposta inválida ou em formato inesperado.':
    'Não foi possível consultar a MisticPay. Confira a conexão e tente novamente.';
  raiseFailure({message,action,providerStatus,providerCode,requestId});
 }
 if(response.ok){
  if(!decode)return data;
  try {return decode(data);}
  catch {
   raiseFailure({message:'A MisticPay retornou dados de transação inválidos.',action,providerStatus,providerCode:'INVALID_RESPONSE',requestId});
  }
 }
 const absent = action==='check'&&missingTransaction(providerStatus,data);
 if(absent&&!requireExisting)return null;
 const providerCode = diagnosticCodes.has(data.code)?data.code:absent?'TRANSACTION_NOT_FOUND':undefined;
 raiseFailure({
  message:absent?missingMessage:providerMessage(providerStatus,providerCode,action),
  action,providerStatus,providerCode,requestId,
  definitive:action==='create'&&definitiveErrors.get(providerCode)===providerStatus
 });
}

export function readTransaction(row) {
 const providerId = row?.transactionId;
 const id = typeof providerId==='string'?providerId:Number.isSafeInteger(providerId)&&providerId>0?String(providerId):'';
 if(!transactionIdPattern.test(id)||row?.transactionType!=='DEPOSITO'||row?.transactionMethod!=='PIX'||!states.has(row?.transactionState)){
  throw Object.assign(new Error('A MisticPay retornou dados de transação inválidos.'),{status:502});
 }
 return {id,state:row.transactionState};
}

function readPayment({transaction:row}) {
 const payment = readTransaction(row);
 const cents = Math.round(row.value*100);
 if(!Number.isSafeInteger(cents)||cents<=0||cents/100!==row.value)throw new Error();
 const timestamp = typeof row.updatedAt==='string'?Date.parse(row.updatedAt):NaN;
 if(row.updatedAt!=null&&!Number.isFinite(timestamp))throw new Error();
 return {...payment,cents,updatedAt:Number.isFinite(timestamp)?new Date(timestamp).toISOString():null};
}

export function lookupMisticPay(fetchImpl, credentials, transactionId, {requireExisting=false}={}) {
 return requestMisticPay(fetchImpl,credentials,'check',{transactionId},{requireExisting,decode:readPayment});
}
