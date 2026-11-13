# Arena Vôlei

Sistema de gestão de quadras de vôlei em português, com painel administrativo, agenda, cadastro de quadras e controle de recebimentos.

## Hospedar na Cloudflare

Veja [docs/cloudflare.md](docs/cloudflare.md). O site e a API usam Workers e SQLite em Durable Object, sem Docker ou Containers. O nome do Worker é `agendamentos`.

```sh
npm ci
npm run build
npm run deploy:cloudflare
```

No painel conectado ao GitHub: branch `main`, raiz `/`, build `npm run build` e deploy `npm run deploy:cloudflare`. Em um banco novo, o acesso inicial é usuário `admin` e senha `admin`. O segredo opcional `ADMIN_INITIAL_PASSWORD` substitui a senha inicial.

Na Cloudflare, os comprovantes Pix têm conferência manual: o administrador abre o arquivo, informa o valor recebido e confirma o crédito na conta antes de aprovar. O OCR descrito abaixo aplica-se somente ao modo Node local.

## Sistemas filhos e identidade própria

No Worker Cloudflare, **Meu sistema → Criar sistema filho** cria uma cópia independente de quadras, reservas, comprovantes e histórico financeiro. Cada filho tem senha própria, logo personalizável e subdomínio. Cada filho conecta sua conta em **Financeiro → Configurar Mercado Pago**. Sessões e credenciais Mercado Pago não são compartilhadas. Conecte o subdomínio ao mesmo Worker na Cloudflare para ativar o acesso. Veja [as instruções de configuração](docs/cloudflare.md#sistema-mãe-e-sistemas-filhos).

## Catálogo público e reservas automáticas

Compartilhe `/catalogo` no domínio da mãe ou de qualquer filho. O cliente consulta quadras ativas, horários livres e preços, informa nome e telefone e reserva sem login. A reserva aparece imediatamente no painel, com pagamento pendente e link privado para consulta e pagamento pelo Pix ou Mercado Pago da própria arena.

Em **Minhas quadras → Agendamento online**, configure abertura e fechamento ou pause novas reservas. O padrão é das 06h às 23h, com reservas de 30 minutos a 4 horas e até 180 dias de antecedência. Dados de outros clientes não aparecem no catálogo; conflitos são verificados novamente no servidor.

## Notificações de agendamento por WhatsApp

Em **Meu sistema → Notificações WhatsApp**, configure a URL HTTPS da Evolution Go e o token da instância conectada ao WhatsApp. Cadastre o WhatsApp do administrador que receberá os avisos de novos agendamentos. O telefone do cliente da reserva não é usado como destinatário. A configuração é independente em cada mãe ou filho; as credenciais e o histórico de notificações não são copiados ao criar sistemas filhos.

O envio é opcional e começa desativado. Novos agendamentos pelo painel ou catálogo geram avisos quando habilitado, sem disparar mensagens para reservas antigas. Salvar a configuração não envia mensagens; **Verificar conexão** consulta a sessão do WhatsApp. Falhas no envio não cancelam reservas. O painel mostra os últimos resultados; **Aceita pela API** não significa entregue ou lida no WhatsApp. Resultados incertos não são reenviados automaticamente.

A integração usa a rota da Evolution Go **`POST /send/text`**, autenticada pelo cabeçalho **`apikey`** com o token da instância. Não usa `/message/sendText/{instance}` da Evolution API. Cadastre o token somente no formulário, sem colocá-lo no Git ou no chat. Para ativar o envio real, são necessários a URL do servidor, o token e uma sessão WhatsApp conectada. Veja [a configuração na Cloudflare](docs/cloudflare.md#notificações-whatsapp-com-evolution-go).

## Menu lateral

O painel possui menu lateral com acesso à visão geral, agendamentos, quadras, financeiro, configurações e catálogo público. No computador, use a seta ou o botão de menu para recolher e expandir; a preferência fica salva no navegador. No celular, o botão do cabeçalho abre o menu. Escolher uma página, tocar fora ou pressionar Esc fecha o menu. A opção de sair continua disponível no celular.

## Tema claro e escuro

Use o botão de tema no topo do painel ou das páginas públicas. A preferência é salva no navegador para o domínio acessado. No primeiro acesso, o sistema acompanha o tema do dispositivo até você escolher outro. A opção está disponível na mãe e nos filhos, inclusive no catálogo e nas páginas de pagamento.

## Executar

Requer Node.js 24.5 ou superior, Tesseract OCR (idioma `eng`) e Poppler (`pdftotext`, `pdftoppm`). Não há dependências npm externas. Em Debian/Ubuntu, os pacotes do leitor são `tesseract-ocr`, `tesseract-ocr-eng` e `poppler-utils`.

```sh
cd /workspace/agendamentos
npm start
```

O servidor usa a porta 3000. No primeiro acesso, crie a senha do administrador (mínimo de 10 caracteres). Configure esse acesso antes de expor o servidor à internet. Para desenvolvimento com reinício automático: `npm run dev`.

## Funcionalidades

- Cadastro de quadras de areia, quadra e poliesportivas, com preço por hora e ativação/desativação.
- Reservas com cliente, telefone, data, horário e observações. Valor proporcional à duração, com mínimo de 30 minutos e bloqueio de sobreposição na mesma quadra.
- Filtros de data e pagamento, cancelamento de reservas não pagas e liberação do horário.
- Cobrança online pelo Checkout Pro do Mercado Pago: link compartilhável, confirmação por webhook assinado, consulta de status e histórico financeiro. Formas de pagamento dependem da conta do Mercado Pago.
- Pix direto com chave da arena, página de pagamento por link privado, envio de comprovante e leitura local do valor em PNG, JPG ou PDF.
- Acesso administrativo com senha armazenada por scrypt, cookie HttpOnly e limite de tentativas de login.
- Dados persistidos em SQLite; sessões em memória expiram em 12 horas e exigem novo login após reinício.

## Configuração

`PORT` (padrão `3000`), `HOST` (padrão `0.0.0.0`), `DATA_DIR` (padrão `./data`, relativo ao código). Use `COOKIE_SECURE=1` em publicação com HTTPS. Se usar proxy reverso, ele deve encaminhar o host original e `X-Forwarded-Proto`. Faça backup consistente de `data/arena.sqlite` com a API de backup do SQLite ou com o servidor parado; o banco usa WAL.

## Validação

```sh
npm test
```

O teste de integração usa banco temporário e porta 3217. Exercita autenticação, reservas, conflitos, cálculo proporcional, pagamentos, cancelamento, desativação de quadra e persistência após reinício.

Os testes de pagamentos usam um cliente simulado, bancos temporários e portas dinâmicas. Cobrem assinatura, webhook duplicado, estorno, valor/conta/ambiente divergentes, reutilização de link e respostas incertas. Não fazem cobranças reais ou validam a conta do Mercado Pago.

Os testes Pix cobrem permissões, divergência de valor, aprovação explícita, reenvio, duplicidade, expiração e concorrência com o checkout. Os testes de OCR executam Tesseract e Poppler de verdade com comprovantes fictícios em imagem, PDF com texto e PDF escaneado.

## Pix com envio de comprovante

1. No **Financeiro → Pix direto**, cadastre a chave Pix da arena e o nome do favorecido.
2. Na reserva, selecione **Pix + comprovante**, gere o link e envie ao cliente. O cliente não precisa acessar a conta administrativa.
3. O cliente confere a chave e o nome no aplicativo do banco, transfere o valor exato e envia um comprovante PNG, JPG ou PDF de até 5 MB.
4. O leitor extrai o valor em reais, converte para centavos e compara com o total da reserva. Valor coincidente aparece como **Valor compatível · em análise**. Valores ambíguos, ilegíveis ou divergentes ficam sinalizados para conferência.
5. Em **Ver comprovante**, o administrador abre o original e confere o crédito na conta. Somente um comprovante com valor compatível pode ser aprovado, após marcar **Conferi o recebimento na conta**. Essa aprovação dá baixa no pagamento. Se houver divergência, o administrador recusa e o cliente pode enviar outro arquivo.

A leitura de um comprovante não verifica autenticidade, destinatário ou entrada de dinheiro na conta e nunca confirma pagamento sozinha. Para confirmação bancária automática, use a integração Mercado Pago. O Pix direto funciona sem credenciais desse provedor.

Cada link Pix vale por 7 dias e contém um token aleatório; trate-o como privado. A chave e o favorecido são preservados ao gerar o link, mesmo que a configuração mude depois. Após expirar, emitir novamente invalida o token antigo. Um comprovante pendente impede reenvio até análise; arquivos idênticos não podem ser reutilizados em outra reserva. Pix direto e checkout Mercado Pago são exclusivos por reserva para evitar cobranças concorrentes.

O OCR roda localmente, sem enviar comprovantes a terceiros. Processa as primeiras 3 páginas de texto ou 2 páginas escaneadas do PDF, com limites de tempo, tamanho e concorrência. Use documentos nítidos e sem senha. Os arquivos originais e o resultado ficam no SQLite e exigem acesso administrativo para download; inclua o banco no backup. Não há limpeza automática do histórico nesta versão.

## Ativar Mercado Pago

Configure os valores nas variáveis seguras do ambiente de execução, sem colocá-los no código ou no chat:

| Variável | Uso |
| --- | --- |
| `MERCADOPAGO_ACCESS_TOKEN` | Access Token da aplicação Mercado Pago; usado somente pelo servidor para `api.mercadopago.com`. Pode ser fornecido por vínculo de segredo do proxy. |
| `MERCADOPAGO_WEBHOOK_SECRET` | Assinatura secreta de Webhooks, disponível nas configurações da aplicação Mercado Pago. Deve estar disponível como valor real no processo: a verificação HMAC acontece localmente, não pelo proxy. |
| `APP_BASE_URL` | Origem pública HTTPS, sem caminho, por exemplo `https://sua-arena.com.br`. O endereço deve ser acessível pelo Mercado Pago. |
| `MERCADOPAGO_MODE` | `test` por padrão; use contas e credenciais de teste compatíveis. Altere para `production` somente após validar o fluxo e configurar a conta recebedora real. |
| `COOKIE_SECURE` | `1` para publicação com HTTPS. |

Na aplicação Mercado Pago, configure notificações de **Pagamentos** para `https://SEU-DOMINIO/api/payments/webhook` e use a assinatura secreta dessa mesma aplicação. O link de notificação também é enviado na criação de cada preferência. Reinicie o servidor após alterar variáveis. A rede precisa permitir saída HTTPS para `api.mercadopago.com`; o checkout do cliente abre no domínio do Mercado Pago. `npm start` respeita os proxies herdados com `--use-env-proxy`.

Depois de configurar, o administrador seleciona **Mercado Pago**, gera o link e envia ao cliente. O checkout abre no site do Mercado Pago, sem coletar dados de cartão no sistema da arena. A volta para `/pagamento` mostra apenas uma mensagem informativa; parâmetros de retorno não confirmam o pagamento. A confirmação exige assinatura válida e uma consulta à API que verifique conta recebedora, referência, valor integral, moeda BRL e ambiente. Notificações repetidas são idempotentes; uma consulta administrativa também pode reconciliar o pagamento. O painel atualiza a cada 30 segundos enquanto estiver visível.

O modo de teste usa `sandbox_init_point`; produção usa `init_point`. Credenciais e domínio não estão incluídos no projeto. A integração ainda precisa ser validada com a conta e o domínio reais; um teste local com respostas simuladas não comprova recebimento bancário.

## Escopo atual

As reservas podem ser criadas pelo administrador ou pelo catálogo público. Avisos de novos agendamentos podem ser enviados por WhatsApp quando a Evolution Go estiver configurada. Não há emissão de estornos nesta versão. Para devolver valores ou tratar contestações, use o painel Mercado Pago; o webhook ou a consulta de status atualiza o registro local. Pagamentos duplicados ou estornos parciais ficam sinalizados para conferência. O histórico inclui cobranças pendentes, aprovadas, estornadas e contestadas; os totais recebidos contam reservas integralmente pagas uma vez, sem deduzir taxas do provedor.

O link expira em 24 horas. O horário permanece reservado até uma decisão administrativa: não há liberação automática. Reservas com cobrança online não permitem cancelamento ou baixa manual no sistema, para evitar liberar um horário com pagamento pendente ou duplicar recebimentos. Gerencie a cobrança no Mercado Pago antes de qualquer ajuste; uma resposta incerta na criação bloqueia outra tentativa até investigação no provedor. Não há renovação automática de preferências expiradas. Registros manuais antigos são preservados. Novos recebimentos usam o checkout Mercado Pago ou o fluxo Pix com análise de comprovante. Valores são armazenados em centavos; o resumo de hoje usa o fuso de São Paulo.

Antes de uso público, configure HTTPS, backup e o acesso inicial do administrador. Para Pix direto, cadastre sua chave no financeiro; para checkout online, configure os requisitos do Mercado Pago acima.
