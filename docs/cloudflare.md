# Hospedagem integral na Cloudflare

O sistema usa Workers com Assets para o site e API, um Durable Object com SQLite para os dados e um Container Linux para ler comprovantes. O banco principal não fica no disco do Container: esse disco é efêmero. Reiniciar ou deixar o OCR dormir não apaga reservas, pagamentos, chave Pix ou comprovantes.

Esta configuração requer **Workers Paid com Containers habilitados**, Node.js 24.5+ e Docker em execução na máquina que fará o deploy. Há cobrança de uso de Workers, Durable Objects e Containers. `max_instances: 1` limita o OCR a uma instância ativa; não é um limite de gastos da conta. Nenhum recurso é criado apenas por adicionar estes arquivos ao repositório.

## Preparar o acesso

Na raiz do repositório:

```sh
npm ci
npx wrangler login
npx wrangler whoami
```

Use a autenticação da sua conta Cloudflare. Em CI, configure `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` como segredos/variáveis do executor. O token precisa das permissões de publicação de Workers, Durable Objects e Containers da conta escolhida. Não coloque tokens em `wrangler.jsonc`, no código, no chat ou no Git.

O nome do Worker é `arena-volei`. Em uma conta com múltiplos projetos, confirme o projeto e a conta antes de publicar. Para usar um domínio próprio, configure um Custom Domain para o Worker na Cloudflare e use essa origem HTTPS nos links e no Mercado Pago.

## Testar antes de publicar

```sh
npm test
npm run test:cloudflare
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
npx wrangler dev
```

`npm run test:cloudflare` usa o runtime local real Workers/Durable Objects e um transporte exclusivo de teste para encaminhar o OCR ao processo nativo local. Ele valida login, reservas, leitura real do comprovante, BLOBs de 5 MB e persistência após reinício, sem depender da ponte de rede Docker. Requer Tesseract e Poppler instalados no host. O teste usa banco e dados fictícios próprios; não conecta à conta Cloudflare.

Para validar também o transporte dos Containers, execute `npm run test:cloudflare:containers`. Esse comando e `wrangler dev` precisam de Docker e de uma ponte de rede alcançável pelo emulador. O teste básico sem recibos está disponível com `node scripts/test-cloudflare.mjs --without-ocr`. Faça também um ciclo completo com dados fictícios: acesso administrativo, quadra, reserva, chave Pix, link do cliente, envio de comprovante, leitura e conferência do administrador. O modo local usa dados locais do Wrangler; não conecta automaticamente ao banco de produção. Um dry-run valida o empacotamento e as ligações do Worker, mas não comprova que Containers foram provisionados ou que a conta pode publicar.

O servidor de OCR também pode ser verificado isoladamente:

```sh
docker build --platform linux/amd64 -f cloudflare/Dockerfile -t arena-volei-ocr .
docker run --rm -p 8080:8080 arena-volei-ocr
```

Em outro terminal, `GET /health` deve responder `{"ok":true}`. Para testar `/read`, faça POST binário de um comprovante fictício com `Content-Type: image/png`, `image/jpeg` ou `application/pdf`. O serviço limita o arquivo a 5 MB e devolve somente o valor e os candidatos; não devolve o texto pessoal extraído. Ele é interno: o Worker não publica uma rota de OCR genérica.

## Publicar e configurar a arena

O primeiro administrador é criado a partir do segredo `ADMIN_INITIAL_PASSWORD`, com pelo menos 10 caracteres. Cadastre a senha pelo gerenciador de segredos ou pelo comando abaixo. Sem esse segredo e com banco vazio, a API responde indisponível em vez de permitir que o primeiro visitante tome a conta. A senha só é aplicada na inicialização de um banco vazio; alterar o segredo depois não redefine a senha de uma conta existente.

```sh
npx wrangler secret put ADMIN_INITIAL_PASSWORD
```

Você pode reforçar as rotas administrativas com Cloudflare Access. As páginas e APIs públicas de Pix (`/pix`, `/pix.js`, `/api/pix/payments/*`) e o webhook Mercado Pago (`/api/payments/webhook`) precisam continuar acessíveis aos clientes e ao provedor; uma regra que proteja indiscriminadamente todas as rotas impedirá esses fluxos.

```sh
npx wrangler deploy
```

Esse comando publica o Worker, aplica as migrações de Durable Objects e constrói/envia a imagem OCR. O primeiro provisionamento de Containers pode levar alguns minutos. Não repita o deploy somente porque o primeiro processamento ainda está iniciando: consulte `npx wrangler containers list` e os logs da Cloudflare.

O deploy informa o endereço HTTPS real do Worker. Abra esse endereço, entre com a senha administrativa configurada no segredo e cadastre a chave Pix em **Financeiro → Pix direto**. Não crie uma senha padrão no código. Os links Pix emitidos usam a origem acessada pelo administrador; use o endereço público que será compartilhado com os clientes.

O Pix direto com comprovante não precisa de credenciais Mercado Pago. O valor lido fica em análise até o administrador conferir o crédito na conta e aprovar. A leitura do arquivo não confirma recebimento bancário.

## Mercado Pago opcional

No dashboard do Worker, configure `APP_BASE_URL` com a origem pública HTTPS, sem caminho. O exemplo mantém `MERCADOPAGO_MODE=test`; confirme o fluxo com contas de teste antes de mudar para `production`. Cadastre os valores pelo gerenciador de segredos da Cloudflare ou pelo Wrangler:

```sh
npx wrangler secret put MERCADOPAGO_ACCESS_TOKEN
npx wrangler secret put MERCADOPAGO_WEBHOOK_SECRET
```

Os comandos recebem os valores de forma interativa. Não passe valores na linha de comando. Configure no Mercado Pago o webhook de **Pagamentos** em `https://SEU-DOMINIO/api/payments/webhook`. O mesmo segredo de assinatura precisa estar no Worker. Ao redeployar, mantenha as variáveis não secretas no `wrangler.jsonc` ou use a gestão de variáveis da Cloudflare consistentemente para não sobrescrever alterações do dashboard.

Após alterar `APP_BASE_URL` ou o modo, publique a configuração atualizada e teste uma nova conexão. Campos presentes não comprovam credenciais válidas; a validação exige criar uma cobrança de teste, concluir o checkout e observar a notificação assinada e a confirmação consultada no Mercado Pago.

## Persistência e operação

- A namespace `ARENA` usa sempre a mesma instância `main`, com SQLite persistente. As sessões administrativas também são persistentes; a expiração continua sendo aplicada.
- `RECEIPT_OCR` controla apenas o Container. Arquivos temporários são removidos após a leitura; o original do comprovante fica no SQLite do Durable Object para análise administrativa.
- Reiniciar ou atualizar o Container não migra ou apaga o banco. Não remova as bindings, renomeie classes, exclua a namespace ou altere a identidade `main` sem um plano de migração.
- O banco local `data/arena.sqlite` não é enviado automaticamente ao Durable Object. Não publique esse arquivo com os Assets ou na imagem Docker. Uma arena já em uso local precisa de migração de dados planejada antes de trocar o endereço de produção.
- A configuração inclui a migração inicial `v1`. Preserve o histórico e acrescente novas migrações quando mudar classes; não reutilize `v1` para apagar/recriar um banco existente.
- Configure backup e retenção compatíveis com os dados de pagamento e comprovantes. Para recuperação e exportação, consulte os recursos de backup/Time Travel de Durable Objects disponíveis na sua conta.

Referências oficiais: [Containers e Wrangler](https://developers.cloudflare.com/containers/configuration/wrangler/), [ciclo de vida](https://developers.cloudflare.com/containers/concepts/architecture/), [SQLite em Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [limites de Containers](https://developers.cloudflare.com/containers/platform/limits/) e [assets de Workers](https://developers.cloudflare.com/workers/static-assets/).

## Evidências de validação desta configuração

- 26 testes da aplicação Node passaram.
- 9 verificações passaram no Wrangler/workerd e SQLite Durable Object com OCR nativo real pelo transporte exclusivo de teste, incluindo comprovante de 5 MiB e reinício completo.
- A imagem Docker do OCR foi construída e leu PNG, JPEG, PDF com texto e PDF escaneado fictícios corretamente.
- O dry-run do Wrangler gerou o bundle e a imagem, sem publicar recursos externos.
- O transporte integrado do emulador de Containers não pôde ser concluído neste ambiente: a ponte Docker local tentou escutar em `172.17.0.1`, endereço ausente no namespace do executor. A tentativa fora do sandbox apresentou a mesma falha. A configuração de produção não foi alterada para contornar esse problema. Teste esse transporte em uma máquina com Docker acessível e valide a primeira publicação na conta Cloudflare.
- Nenhum recurso foi publicado na Cloudflare. Autenticação, plano e provisionamento na conta ainda precisam ser verificados.
