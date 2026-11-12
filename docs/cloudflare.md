# Hospedar na Cloudflare sem Containers

O Worker `agendamentos` serve o site e a API. O Durable Object `Arena` mantém SQLite, sessões e comprovantes. O deploy não usa Docker, Containers ou serviços externos de OCR.

## Deploy pelo GitHub

No Worker conectado a `lucasdallan-hub/agendamentos`, configure branch `main`, diretório raiz `/`, build `npm run build` e deploy `npm run deploy:cloudflare`. Node está fixado em `.node-version`.

O token precisa permitir publicação de Workers e Durable Objects na conta escolhida. Containers não são necessários. Consulte a disponibilidade e os limites de SQLite Durable Objects no plano da conta.

Configure o segredo `ADMIN_INITIAL_PASSWORD` no Worker (10 a 200 caracteres). Sem ele, um banco novo permanece bloqueado. Não compartilhe senhas ou tokens no Git ou no chat.

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
