# Hospedar na Cloudflare sem Containers

O Worker `agendamentos` serve o site e a API. O Durable Object `Arena` mantém SQLite, sessões e comprovantes. O deploy do Worker dispensa Docker e Containers.

## Deploy pelo GitHub

No Worker conectado a `lucasdallan-hub/agendamentos`, configure branch `main`, diretório raiz `/`, build `npm run build` e deploy `npm run deploy:cloudflare`. Node está fixado em `.node-version`.

O token precisa permitir publicação de Workers e Durable Objects na conta escolhida. Containers não são necessários. Consulte a disponibilidade e os limites de SQLite Durable Objects no plano da conta.

Em um banco novo, entre com usuário `admin` e senha `admin`. O segredo opcional `ADMIN_INITIAL_PASSWORD` permite definir outra senha inicial (10 a 200 caracteres). Contas existentes mantêm sua senha. O acesso padrão é público no código; configure uma senha própria para uso público.

## Validar e executar

```sh
npm ci
npm test
npm run test:cloudflare
npm run build
npm run dev:cloudflare
```

`npm test` cobre as APIs com SQLite local e respostas simuladas dos provedores. `npm run test:cloudflare` testa o Worker e o SQLite locais, incluindo conferência manual de comprovantes de até 5 MiB, autorização e persistência após reinício.

Para publicar de uma máquina autenticada:

```sh
npx wrangler login
npx wrangler whoami
npm run deploy:cloudflare
```

## Comprovantes Pix

O cliente pode enviar um arquivo JPG, PNG ou PDF de até 5 MB. Na reserva, abra **Ver comprovante**, confira o crédito na conta e informe o valor recebido. A aprovação exige valor igual ao total da reserva e confirmação de recebimento. O arquivo original e a decisão ficam no histórico da arena.

## Pix via MisticPay

A Arena usa a API de transações em `https://api.misticpay.com/api` com Basic e o par `pk_` e `sk_`. A API Finance usa outro domínio, outras chaves e um contrato próprio. A Arena usa apenas as rotas `POST /transactions/create` e `POST /transactions/check` da API de transações. [API de transações](https://docs.misticpay.com/) · [API Finance](https://docs.finance.misticpay.com/authentication)

1. Na MisticPay, abra **API → Chaves de Acesso → Criar Chave de Acesso**. Marque `TRANSACTION_CREATE` e `TRANSACTION_READ` e copie o Client ID e o Client Secret do mesmo par. [Autenticação da MisticPay](https://docs.misticpay.com/#authentication)
2. Em **Financeiro → Configurar MisticPay**, informe o Client ID e o Client Secret. O painel mantém a origem HTTPS salva ou usa o endereço pelo qual a arena foi aberta. Em desenvolvimento por HTTP, informe a origem HTTPS pública do webhook. **Salvar configuração** guarda o par criptografado no Durable Object da arena e habilita o Pix para novas reservas sem consulta de teste. Se já houver cobranças e as chaves forem trocadas, a Arena consulta automaticamente uma cobrança própria para comprovar que o novo par acessa a mesma conta. As cobranças continuam com as chaves ativas enquanto a troca estiver pendente.
3. Quando o cliente escolher **Pix via MisticPay**, o catálogo pode emitir QR Code e Pix copia e cola. O CPF é enviado à MisticPay na emissão e fica fora do banco da arena. Se a criação terminar com resultado incerto, a cobrança segue vinculada à mesma referência para consulta.

Cada cobrança registra uma URL HTTPS de webhook própria. A notificação aciona uma consulta autenticada. Quando necessário, a Arena também consulta o identificador da cobrança devolvido pela MisticPay. A baixa exige `COMPLETO` com a referência do pedido e o valor integral da reserva. Se o webhook anunciar pagamento e a API ainda mostrar a cobrança pendente, o Worker agenda até quatro novas consultas. Ao abrir os agendamentos, o painel também retoma consultas pendentes das últimas 24 horas. A página da reserva atualiza o status enquanto estiver aberta. O horário segue reservado durante a conciliação.

### Publicação e rollback da MisticPay

1. Para uma nova implantação, guarde uma chave aleatória de 32 bytes, representada por 64 dígitos hexadecimais, e cadastre-a como **Worker Secret** `MISTICPAY_CREDENTIALS_KEY`. O Worker também aceita `MISTICPAY_MANAGED_CREDENTIALS_KEY` para novas configurações quando a primeira chave está ausente ou inválida. Credenciais já cifradas seguem vinculadas à chave usada para gravá-las. Preserve os segredos entre deploys. Para execução Node, use as variáveis de servidor com os mesmos nomes.
2. Confirme a saída HTTPS para `api.misticpay.com`. Registre o ID da versão atual em **Workers & Pages → agendamentos → Deployments**. Execute `npm test`, `npm run test:cloudflare` e `npm run build`. Publique pelo fluxo GitHub configurado ou com `npm run deploy:cloudflare -- --keep-vars` em uma máquina autenticada.
3. Confira o site e o login e salve a configuração. As credenciais legadas são cifradas na primeira leitura administrativa ou uso. A inspeção de logs usa a operação, o status, o código seguro, a referência e o horário.
4. Para reverter, priorize uma versão compatível com as credenciais cifradas. Use o botão de rollback em **Deployments** ou `npx wrangler rollback ID_DA_VERSAO`. As reservas e cobranças ficam no banco atual. Uma versão anterior à cifragem perde acesso às chaves migradas. Nessa situação, trate o Pix MisticPay como indisponível até restaurar a versão compatível e mantenha o segredo existente. [Rollback do Worker](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

As provas automatizadas usam respostas simuladas. A emissão usa `TRANSACTION_CREATE` e a confirmação automática usa `TRANSACTION_READ`. [Consulta](https://docs.misticpay.com/#check-transaction) · [Erros e referência de suporte](https://docs.misticpay.com/#errors)

## Atualização e persistência

O histórico de migrações `v1` é preservado. A classe legada `ReceiptOCR` permanece exportada como Durable Object comum para compatibilidade com implantações que já aplicaram a migração. Não renomeie a classe `Arena`, sua binding ou a instância `main`, pois elas identificam o banco existente.

O banco local Node não é enviado ao Worker. Faça backups dos dados persistentes. Recursos de Containers de uma implantação antiga podem precisar ser removidos pelo painel da Cloudflare após verificar que não são mais usados; este código não os exclui remotamente.

## Sistema mãe e sistemas filhos

Acesse **Meu sistema** no painel. O sistema original é a mãe: somente seu administrador pode criar filhos. A criação está disponível no Worker; no modo Node local, use `npm run dev:cloudflare` para desenvolver e testar esse fluxo.

1. Clique em **Criar sistema filho** e informe nome, identificador único, subdomínio completo e senha própria de 10 a 200 caracteres. O usuário será `admin`.
2. A cópia inclui todas as quadras, reservas, configurações Pix, links Pix, comprovantes originais e histórico financeiro existentes naquele momento. A logo é copiada e o nome passa a ser o informado. Filhos não recebem sessões, senha administrativa, outros filhos ou credenciais de pagamento da mãe.
3. Na Cloudflare, conecte o hostname ao **mesmo Worker `agendamentos`** em **Settings → Domains & Routes → Add → Custom Domain**. Use um domínio que você controla na conta. Aguarde DNS e certificado HTTPS ficarem ativos antes de abrir o filho. Não crie outro Worker ou outro projeto Git para cada filho. Também é possível usar uma rota wildcard já configurada com DNS compatível.
4. Entre no endereço do filho com `admin` e a senha definida. Em **Meu sistema → Alterar nome e logo**, envie PNG ou JPEG de até 250 KB. A identidade aparece no login, no painel e nas páginas de pagamento. Em **Alterar subdomínio**, é possível trocar o hostname depois de conectar o novo domínio ao Worker; será necessário entrar novamente. O endereço anterior deixa de acessar o filho.

O sistema registra subdomínios, mas não modifica sua conta Cloudflare, DNS ou certificados automaticamente. Não é possível criar subdomínios filhos de `workers.dev`; use seu domínio próprio. O cadastro mostra **Cópia criada** quando os dados foram provisionados, o que não comprova DNS ou HTTPS ativos.

Cada filho usa uma instância separada do Durable Object `Arena`, identificada por `child:<identificador>`. A mãe mantém a instância original `main`. Dados, sessões e alterações são independentes; alterações posteriores na mãe não se propagam aos filhos. A lista da mãe registra nome e data originais da cópia.

A primeira criação registra o hostname utilizado como endereço da mãe. Para definir explicitamente o endereço canônico, configure a variável `MOTHER_HOST`, somente com o hostname (por exemplo `painel.seudominio.com.br`), no Worker e mantenha-a nos próximos deploys. Depois de criar o primeiro filho, hostnames desconhecidos recebem erro em vez de acessar os dados da mãe. Ao trocar o endereço da mãe, ajuste `MOTHER_HOST`.

Cada filho pode conectar sua própria conta em **Financeiro → Configurar Mercado Pago**. Informe Access Token, segredo do webhook, ambiente e origem HTTPS do próprio filho. O servidor consulta a conta antes de salvar; credenciais são persistidas no banco privado da arena e não são devolvidas nas APIs, nem copiadas para outros sistemas. Backups desse banco contêm dados sensíveis e precisam da mesma proteção do banco principal.

Configure notificações de Pagamentos na aplicação Mercado Pago de cada arena para `https://SUBDOMINIO/api/payments/webhook`, com o mesmo segredo informado no formulário. Salvar confirma o acesso à conta, mas não testa entrega do webhook ou uma cobrança real: valide ambos no ambiente de teste do provedor. Ao trocar o subdomínio, atualize também a origem pública e o webhook. Com cobranças próprias já existentes, a conexão só permite manter a mesma conta e ambiente, preservando conciliação e estornos.

O histórico Mercado Pago e MisticPay copiado fica disponível no filho para consulta. Cobranças herdadas são conciliadas pela arena que as criou. Novas reservas podem gerar cobranças com as credenciais próprias do filho. A cópia não transfere dinheiro nem cria uma conta Mercado Pago. O filho usa as configurações Pix copiadas e pode alterá-las no financeiro.

A transferência automática aceita até 20 MiB de dados serializados, incluindo comprovantes. Acima disso, a criação é recusada antes do provisionamento, sem cópia parcial; faça uma migração assistida. A importação no destino é transacional. Se houver falha de provisionamento, o identificador permanece reservado com status pendente para impedir sobrescrita; investigue antes de reutilizá-lo.

## Catálogo público em cada domínio

O catálogo está em `https://SEU-DOMINIO/catalogo`, para a mãe e todos os filhos, inclusive os já existentes. O catálogo segue a identidade, os dados e a conexão financeira do hostname acessado. Não exige login do cliente e não mostra nomes, telefones ou observações das reservas de terceiros.

Em **Minhas quadras → Agendamento online**, ajuste o funcionamento ou desative novos agendamentos. O padrão aceita reservas entre 06h e 23h, em intervalos de 30 minutos, até 180 dias à frente. A duração pode variar de 30 minutos a 4 horas. Não são aceitos horários já passados no fuso de São Paulo. Filhos novos copiam a configuração atual da mãe e podem alterá-la independentemente.

A confirmação cria imediatamente uma reserva com pagamento pendente. O total é calculado no servidor pelo preço da quadra; conflitos e quadras desativadas são verificados novamente antes da gravação. Reenvios com o mesmo identificador não duplicam a reserva. Há limite de dez reservas públicas por origem por hora, separado do login administrativo.

O cliente recebe um link privado em `/catalogo#TOKEN`, válido até o dia seguinte ao jogo. Esse link permite consultar apenas a própria reserva e iniciar pagamento por Pix direto, Pix via MisticPay ou Mercado Pago, conforme as conexões da arena. Uma cobrança iniciada bloqueia cobranças concorrentes. O link não dá acesso ao painel, a dados de outros clientes ou a cancelamentos administrativos. Os links privados do catálogo não são copiados para os filhos.

A reserva já ocupa o horário antes do pagamento; não há liberação automática por falta de pagamento. O administrador acompanha o financeiro e trata cancelamentos conforme as regras existentes. Salvar uma reserva não comprova recebimento. Configure as credenciais e o webhook de cada arena para usar cobrança online; sem conexão financeira, o catálogo ainda confirma a reserva e orienta combinar o pagamento com a arena.

## Notificações WhatsApp com Evolution Go

A integração está disponível na mãe e em cada filho em **Meu sistema → Notificações WhatsApp**. Cada arena mantém sua própria URL, token e número de WhatsApp do administrador. Esses dados e os registros de envio não entram na cópia de um sistema filho. As confirmações são enviadas no momento da criação da reserva. Com o WhatsApp ativo na arena, o Worker verifica a cada minuto as reservas confirmadas, no horário de São Paulo. O administrador recebe a quadra, o início, o término e o tempo restante em dois avisos, ao começar a reserva e quando faltam 10 minutos. O cliente também recebe o lembrete de término.

1. Use a URL `https://api.dallan.pro` e o **token da instância**, não a chave administrativa global. Consulte o [Swagger desta API](https://api.dallan.pro/swagger/index.html). O link completo do Swagger é uma página de documentação; as chamadas usam a base do servidor.
2. Cadastre o WhatsApp do administrador que deve receber os avisos. O sistema também usa o telefone informado na reserva para confirmar o agendamento ao cliente. Configure o código do país para os números locais. O padrão é `55`.
3. Ative os avisos e salve. A chave permanece no banco privado da arena e não é devolvida nas APIs de consulta. A configuração pode ser desativada sem preencher novas credenciais.
4. Clique em **Conectar WhatsApp** para exibir o QR Code no painel. No celular, abra **WhatsApp → Configurações ou ⋮ → Aparelhos conectados → Conectar aparelho** e escaneie a imagem. É possível salvar apenas URL e token e conectar a sessão antes de habilitar os avisos; para o envio, preencha também o número do administrador e ative a opção.
5. A janela verifica a conexão a cada cinco segundos enquanto está aberta e visível. A imagem é temporária e fica oculta após no máximo vinte segundos; use **Atualizar QR Code** se necessário. Fechar, trocar de janela de configuração ou sair da conta encerra as consultas e remove a imagem. Não há envio do QR a serviços externos ou armazenamento no navegador.
6. Use **Verificar conexão** para consultar a sessão já salva sem gerar código ou enviar mensagens. Um resultado conectado descreve a sessão naquele momento. Para confirmar o envio real, use um agendamento de teste e números de cliente e administrador que você controla. Se a conta exigir uma verificação adicional, conclua a autorização no WhatsApp ou no gerenciador da instância.

O protocolo utilizado é `POST /send/text`, com `Content-Type: application/json`, cabeçalho `apikey` contendo o token da instância e corpo com `number`, `text`, `id` e `formatJid`. A rota não contém o nome da instância. É o protocolo da **Evolution Go**, distinto de `/message/sendText/{instance}` da Evolution API. A consulta de conexão usa `GET /instance/status` com a mesma autenticação. A conexão pelo site consulta o status antes de chamar `GET /instance/qr` e exibe somente a imagem PNG retornada pela instância. Uma sessão já autorizada não é reiniciada para gerar outro código; o painel não chama `POST /instance/connect` nem altera webhooks ou inscrições da instância. Referência: [Swagger da API Dallan](https://api.dallan.pro/swagger/index.html).

O envio para o cliente e para o administrador ocorre após gravar um novo agendamento do painel ou do catálogo. Uma falha na Evolution Go não impede a reserva. Em **Notificações recentes**, cada destinatário tem seu próprio resultado. Os status incluem **Aguardando envio**, **Envio em andamento**, **Aceita pela API**, **Falha no envio** ou **Resultado incerto**. Pendências que ainda não iniciaram o envio são retomadas ao carregar o histórico no painel. Respostas incertas, inclusive timeout e erro HTTP 5xx, não são reenviadas automaticamente. Uma resposta aceita pela API não comprova entrega ou leitura no WhatsApp. Em resultado incerto, consulte a Evolution Go antes de tentar qualquer reenvio; não há repetição automática desses resultados.

Salvar a conexão não envia mensagens nem comprova que a instância WhatsApp está conectada. São necessários servidor acessível, token válido e sessão WhatsApp ativa. Se a saída de rede do executor estiver restrita, permita o hostname do seu servidor Evolution Go; não use uma URL interna de Container ou endereço de loopback em produção. Proteja os backups do banco da arena, que inclui as credenciais dessa conexão.

### Diagnosticar conexão com a Evolution Go

O painel informa o HTTP retornado pela API sem exibir tokens ou o corpo privado da resposta: HTTP 401 indica token recusado; HTTP 403 indica acesso negado por permissões ou regras do servidor; HTTP 404 indica rota ou URL base incompatível; HTTP 429 exige aguardar o limite de consultas. DNS, certificado TLS, conexão recusada, timeout e resposta sem JSON têm mensagens distintas.

Configurações antigas salvas com o endereço da página `/swagger/index.html` são corrigidas automaticamente para a base da API, preservando token e número do administrador. Uma instância autorizada mas desconectada é identificada separadamente; o painel não a reinicia nem altera seus webhooks. Corrija a sessão no servidor da API e consulte novamente. Erros HTTP 401/403/404/429 pausam as consultas automáticas da janela de QR até uma nova tentativa manual.

O bloqueio de rede do ambiente de desenvolvimento do Codex deve ser investigado separadamente de uma falha no Worker publicado. Para diagnosticar produção, use a mensagem exibida no site e o endereço do Worker; os testes simulados não comprovam acesso à instância real.
