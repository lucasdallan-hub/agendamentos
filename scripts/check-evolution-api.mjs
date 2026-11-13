// Read-only diagnosis. Never sends messages, creates sessions or requests QR codes.
const rawBase=process.env.EVOLUTION_BASE_URL||'https://api.dallan.pro';
async function response(url,headers={}){
 try{return await fetch(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(12000)});}
 catch{throw Error('UNREACHABLE');}
}
async function main(){
 let base;
 try{base=new URL(rawBase);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error();base.pathname=base.pathname.replace(/\/swagger(?:\/index\.html)?\/?$/i,'')||'/';}
 catch{throw Error('INVALID_URL');}
 const root=base.href.replace(/\/+$/,'');
 const page=await response(root+'/swagger/index.html');
 if(!page.ok)throw Error('DOC_HTTP_'+page.status);
 if(!(await page.text()).toLowerCase().includes('swagger'))throw Error('INVALID_DOC');
 console.log('PASS: documentação Swagger acessível por HTTPS.');
 const schemaResponse=await response(root+'/swagger/doc.json');
 if(schemaResponse.ok){
  let schema;try{schema=await schemaResponse.json();}catch{throw Error('INVALID_SCHEMA');}
  if(!schema.paths||!schema.paths['/instance/status']?.get||!schema.paths['/instance/qr']?.get||!schema.paths['/send/text']?.post)throw Error('INCOMPATIBLE_SCHEMA');
  console.log('PASS: OpenAPI contém as rotas de status, QR Code e envio esperadas.');
 }else console.log(`NÃO VERIFICADO: JSON OpenAPI não disponível no caminho padrão (HTTP ${schemaResponse.status}).`);
 const token=process.env.EVOLUTION_INSTANCE_TOKEN;
 if(!token){console.log('NÃO EXECUTADO: consulta autenticada da sessão; EVOLUTION_INSTANCE_TOKEN não está configurado.');return;}
 if(/[\s\x00-\x1f\x7f]/.test(token))throw Error('INVALID_TOKEN');
 const statusResponse=await response(root+'/instance/status',{apikey:token});
 if(!statusResponse.ok)throw Error('AUTH_HTTP_'+statusResponse.status);
 let result;try{result=await statusResponse.json();}catch{throw Error('INVALID_STATUS');}
 if(result?.message!=='success'||typeof result?.data?.Connected!=='boolean'||typeof result?.data?.LoggedIn!=='boolean')throw Error('INVALID_STATUS');
 console.log(`PASS: consulta autenticada; Connected=${result.data.Connected}, LoggedIn=${result.data.LoggedIn}.`);
}
try{await main();}catch(error){
 const messages={
  UNREACHABLE:'Conexão HTTPS não concluída. Verifique a política de rede do ambiente e a disponibilidade do servidor.',
  INVALID_URL:'EVOLUTION_BASE_URL deve conter uma URL HTTPS válida, sem credenciais ou parâmetros.',
  INVALID_DOC:'A rota da documentação não retornou uma página Swagger.',
  INVALID_SCHEMA:'O servidor não retornou JSON OpenAPI válido.',
  INCOMPATIBLE_SCHEMA:'O OpenAPI diverge das rotas esperadas pela integração.',
  INVALID_TOKEN:'O token configurado tem formato inválido. Cadastre-o pelo canal seguro do ambiente.',
  INVALID_STATUS:'O servidor não confirmou o formato esperado para o status da sessão.'
 };
 const code=String(error.message);
 const http=/^(DOC|AUTH)_HTTP_(\d{3})$/.exec(code);
 console.error('FAIL: '+(messages[code]||(http?`${http[1]==='DOC'?'Documentação':'Consulta autenticada'} retornou HTTP ${http[2]}. Verifique acesso e configuração.`:'O diagnóstico não pôde ser concluído.')));
 process.exitCode=1;
}
