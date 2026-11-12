# Hospedar na Cloudflare sem Containers

O Worker `agendamentos` serve o site e a API. O Durable Object `Arena` mantém SQLite, sessões e comprovantes. O deploy não usa Docker, Containers ou serviços externos de OCR.

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

`npm test` inclui OCR nativo do modo Node e requer Tesseract/Poppler. `npm run test:cloudflare` testa o Worker real com SQLite, envio de comprovante de até 5 MiB, conferência manual, autorização e persistência após reinício, sem Docker ou OCR nativo.

Para publicar de uma máquina autenticada:

```sh
npx wrangler login
npx wrangler whoami
npm run deploy:cloudflare
```

## Comprovantes Pix

Na Cloudflare, arquivos PNG, JPEG e PDF são armazenados para conferência manual. O administrador abre o original, informa o valor recebido e marca que conferiu o crédito na conta. O servidor exige valor igual ao total da reserva e confirmação explícita antes de dar baixa. Envio de arquivo nunca confirma pagamento automaticamente. Comprovantes antigos continuam acessíveis para análise.

O modo Node local mantém o OCR nativo. Mercado Pago continua opcional e usa os segredos e variáveis descritos no README.

## Atualização e persistência

O histórico de migrações `v1` é preservado. A classe legada `ReceiptOCR` permanece exportada como Durable Object comum, sem binding de OCR nem Container, para compatibilidade com implantações que já aplicaram a migração. Não renomeie a classe `Arena`, sua binding ou a instância `main`, pois elas identificam o banco existente.

O banco local Node não é enviado ao Worker. Faça backups dos dados persistentes. Recursos de Containers de uma implantação antiga podem precisar ser removidos pelo painel da Cloudflare após verificar que não são mais usados; este código não os exclui remotamente.

## Sistema mãe e sistemas filhos

Acesse **Meu sistema** no painel. O sistema original é a mãe: somente seu administrador pode criar filhos. A criação está disponível no Worker; no modo Node local, use `npm run dev:cloudflare` para desenvolver e testar esse fluxo.

1. Clique em **Criar sistema filho** e informe nome, identificador único, subdomínio completo e senha própria de 10 a 200 caracteres. O usuário será `admin`.
2. A cópia inclui todas as quadras, reservas, configurações Pix, links Pix, comprovantes originais e histórico financeiro existentes naquele momento. A logo é copiada e o nome passa a ser o informado. Filhos não recebem sessões, senha administrativa, outros filhos ou credenciais Mercado Pago da mãe.
3. Na Cloudflare, conecte o hostname ao **mesmo Worker `agendamentos`** em **Settings → Domains & Routes → Add → Custom Domain**. Use um domínio que você controla na conta. Aguarde DNS e certificado HTTPS ficarem ativos antes de abrir o filho. Não crie outro Worker ou outro projeto Git para cada filho. Também é possível usar uma rota wildcard já configurada com DNS compatível.
4. Entre no endereço do filho com `admin` e a senha definida. Em **Meu sistema → Alterar nome e logo**, envie PNG ou JPEG de até 250 KB. A identidade aparece no login, no painel e nas páginas de pagamento. Em **Alterar subdomínio**, é possível trocar o hostname depois de conectar o novo domínio ao Worker; será necessário entrar novamente. O endereço anterior deixa de acessar o filho.

O sistema registra subdomínios, mas não modifica sua conta Cloudflare, DNS ou certificados automaticamente. Não é possível criar subdomínios filhos de `workers.dev`; use seu domínio próprio. O cadastro mostra **Cópia criada** quando os dados foram provisionados, o que não comprova DNS ou HTTPS ativos.

Cada filho usa uma instância separada do Durable Object `Arena`, identificada por `child:<identificador>`. A mãe mantém a instância original `main`. Dados, sessões e alterações são independentes; alterações posteriores na mãe não se propagam aos filhos. A lista da mãe registra nome e data originais da cópia.

A primeira criação registra o hostname utilizado como endereço da mãe. Para definir explicitamente o endereço canônico, configure a variável `MOTHER_HOST`, somente com o hostname (por exemplo `painel.seudominio.com.br`), no Worker e mantenha-a nos próximos deploys. Depois de criar o primeiro filho, hostnames desconhecidos recebem erro em vez de acessar os dados da mãe. Ao trocar o endereço da mãe, ajuste `MOTHER_HOST`.

Cada filho pode conectar sua própria conta em **Financeiro → Configurar Mercado Pago**. Informe Access Token, segredo do webhook, ambiente e origem HTTPS do próprio filho. O servidor consulta a conta antes de salvar; credenciais são persistidas no banco privado da arena e não são devolvidas nas APIs, nem copiadas para outros sistemas. Backups desse banco contêm dados sensíveis e precisam da mesma proteção do banco principal.

Configure notificações de Pagamentos na aplicação Mercado Pago de cada arena para `https://SUBDOMINIO/api/payments/webhook`, com o mesmo segredo informado no formulário. Salvar confirma o acesso à conta, mas não testa entrega do webhook ou uma cobrança real: valide ambos no ambiente de teste do provedor. Ao trocar o subdomínio, atualize também a origem pública e o webhook. Com cobranças próprias já existentes, a conexão só permite manter a mesma conta e ambiente, preservando conciliação e estornos.

O histórico Mercado Pago copiado é marcado como herdado e não pode ser usado para abrir checkout ou conciliar pela conta do filho. Novas reservas podem gerar cobranças com as credenciais próprias do filho. A cópia não transfere dinheiro nem cria uma conta Mercado Pago. Pix com conferência manual continua funcionando com as configurações copiadas, que cada filho pode alterar no financeiro.

A transferência automática aceita até 20 MiB de dados serializados, incluindo comprovantes. Acima disso, a criação é recusada antes do provisionamento, sem cópia parcial; faça uma migração assistida. A importação no destino é transacional. Se houver falha de provisionamento, o identificador permanece reservado com status pendente para impedir sobrescrita; investigue antes de reutilizá-lo.

## Catálogo público em cada domínio

O catálogo está em `https://SEU-DOMINIO/catalogo`, para a mãe e todos os filhos, inclusive os já existentes. O catálogo segue a identidade, os dados e a conexão financeira do hostname acessado. Não exige login do cliente e não mostra nomes, telefones ou observações das reservas de terceiros.

Em **Minhas quadras → Agendamento online**, ajuste o funcionamento ou desative novos agendamentos. O padrão aceita reservas entre 06h e 23h, em intervalos de 30 minutos, até 180 dias à frente. A duração pode variar de 30 minutos a 4 horas. Não são aceitos horários já passados no fuso de São Paulo. Filhos novos copiam a configuração atual da mãe e podem alterá-la independentemente.

A confirmação cria imediatamente uma reserva com pagamento pendente. O total é calculado no servidor pelo preço da quadra; conflitos e quadras desativadas são verificados novamente antes da gravação. Reenvios com o mesmo identificador não duplicam a reserva. Há limite de dez reservas públicas por origem por hora, separado do login administrativo.

O cliente recebe um link privado em `/catalogo#TOKEN`, válido até o dia seguinte ao jogo. Esse link permite consultar apenas a própria reserva e iniciar pagamento por Pix ou Mercado Pago da arena, quando configurados. Escolher um meio de pagamento bloqueia a cobrança concorrente pelo outro. O link não dá acesso ao painel, a dados de outros clientes ou a cancelamentos administrativos. Os links privados do catálogo não são copiados para os filhos.

A reserva já ocupa o horário antes do pagamento; não há liberação automática por falta de pagamento. O administrador acompanha o financeiro e trata cancelamentos conforme as regras existentes. Salvar uma reserva não comprova recebimento. Configure as credenciais e o webhook de cada arena para usar cobrança online; sem conexão financeira, o catálogo ainda confirma a reserva e orienta combinar o pagamento com a arena.

## Notificações WhatsApp com Evolution Go

A integração está disponível na mãe e em cada filho em **Meu sistema → Notificações WhatsApp**. Cada arena mantém sua própria URL, token e número de WhatsApp do administrador. Esses dados e os registros de envio não entram na cópia de um sistema filho. Reservas copiadas ou criadas antes de ativar o envio não geram disparos retroativos.

1. Informe a URL HTTPS do servidor Evolution Go e o **token da instância** autenticada no WhatsApp, não a chave administrativa global.
2. Cadastre o WhatsApp do administrador que deve receber os avisos. O cliente da reserva não recebe mensagens por esta integração. Para números sem código internacional, configure o código do país; o padrão é `55`.
3. Ative os avisos e salve. A chave permanece no banco privado da arena e não é devolvida nas APIs de consulta. A configuração pode ser desativada sem preencher novas credenciais.
4. Use **Verificar conexão** para consultar a sessão já salva. Esse botão realiza uma consulta sem enviar mensagens. Um resultado conectado descreve a sessão naquele momento; confirme o envio real com um agendamento de teste e um número que você controla.

O protocolo utilizado é `POST /send/text`, com `Content-Type: application/json`, cabeçalho `apikey` contendo o token da instância e corpo com `number`, `text`, `id` e `formatJid`. A rota não contém o nome da instância. É o protocolo da **Evolution Go**, distinto de `/message/sendText/{instance}` da Evolution API. A consulta de conexão usa `GET /instance/status` com a mesma autenticação. Referência: [rotas oficiais da Evolution Go](https://github.com/evolution-foundation/evolution-go/blob/main/pkg/routes/routes.go).

O envio ocorre para novos agendamentos do painel e do catálogo, após a reserva ser gravada. Uma falha na Evolution Go não impede a reserva. O registro de resultados é persistente e aparece em **Notificações recentes**: **Aguardando envio**, **Envio em andamento**, **Aceita pela API**, **Falha no envio** ou **Resultado incerto**. Pendências que ainda não iniciaram o envio são retomadas ao carregar o histórico no painel. Respostas incertas, inclusive timeout e erro HTTP 5xx, não são reenviadas automaticamente. Uma resposta aceita pela API não comprova entrega ou leitura no WhatsApp. Em resultado incerto, consulte a Evolution Go antes de tentar qualquer reenvio; não há repetição automática desses resultados.

Salvar a conexão não envia mensagens nem comprova que a instância WhatsApp está conectada. São necessários servidor acessível, token válido e sessão WhatsApp ativa. Se a saída de rede do executor estiver restrita, permita o hostname do seu servidor Evolution Go; não use uma URL interna de Container ou endereço de loopback em produção. Proteja os backups do banco da arena, que inclui as credenciais dessa conexão.
