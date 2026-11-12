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
