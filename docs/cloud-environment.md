# Ambiente de desenvolvimento na nuvem

A configuração reutilizável está em [cloud/environment-config.json](../cloud/environment-config.json). Os comandos de instalação, inicialização e diagnóstico ficam em `scripts/` e podem ser executados pelo npm. Eles não publicam recursos na Cloudflare.

Use o checkout existente em `/workspace/agendamentos`. Cada tarefa da nuvem já é isolada; não é necessário criar um Git worktree para configurar ou executar o projeto.

## Preparar e executar

Use a versão de Node.js indicada em `.node-version` (`24.22.1`); o projeto exige pelo menos `24.5`.

```sh
cd /workspace/agendamentos
npm run setup:cloud
npm run dev:cloud
```

`setup:cloud` instala as dependências com `npm ci`, preservando o lockfile, e executa o build do Worker em modo de validação. `dev:cloud` inicia o Wrangler local, com os dados persistentes de desenvolvimento em `.wrangler/state`. O fluxo Cloudflare não precisa de Docker ou Containers.

O servidor usa o host `127.0.0.1` e a porta `8787`. Para usar outra porta:

```sh
ARENA_PORT=8790 npm run dev:cloud
```

`ARENA_HOST` permite escolher o endereço de escuta. Verifique quem está usando uma porta antes de encerrar processos; preserve serviços que não foram iniciados pela sua tarefa.

Em outro terminal, confira a aplicação em execução:

```sh
npm run check:runtime
```

O verificador consulta a sessão, a página do catálogo e a API pública do catálogo com a data atual no fuso de São Paulo. Ele pressupõe que o catálogo local esteja habilitado. Ele confirma respostas funcionais, sem criar reservas ou alterar dados. Se mudou a porta ou a origem, informe o endereço ao verificador:

```sh
ARENA_ORIGIN=http://127.0.0.1:8790 npm run check:runtime
```

O banco local não é o banco de produção. Ao restaurar um ambiente, reinicie o servidor: processos e conexões não devem ser considerados parte do snapshot.

## Verificações do projeto

```sh
npm test
npm run test:cloudflare
npm run build
```

`npm test` também executa o OCR nativo do modo Node. Ele exige Tesseract com idioma `eng` e Poppler (`pdftotext` e `pdftoppm`). Os pacotes Debian/Ubuntu são `tesseract-ocr`, `tesseract-ocr-eng` e `poppler-utils`; eles já estavam instalados no ambiente preparado. Os testes Cloudflare usam o Worker e SQLite locais, com conferência manual de comprovantes.

O build não faz deploy. Os comandos existentes de CI continuam sendo `npm run build` e `npm run deploy:cloudflare`; a publicação exige a conta e a autenticação Cloudflare adequadas. Consulte [o guia de hospedagem](cloudflare.md).

## Rede do ambiente

O arquivo versionado solicita `network.type: "unrestricted"`, correspondente à opção **Internet irrestrita** do ambiente. Essa configuração precisa ser aplicada e publicada nas configurações da plataforma.

O JSON do repositório não é carregado automaticamente pelo npm, GitHub ou Wrangler. Ele registra a configuração que deve ser usada no ambiente. Alterar esse arquivo, um script JavaScript ou `wrangler.jsonc` não modifica a política de rede da máquina em execução. Salvar um rascunho também não comprova que a política foi aplicada: use as ações **Salvar/Publicar** da interface do ambiente e confirme o estado observado antes de testar uma conexão nova.

Na configuração preparada, a opção de rede irrestrita foi salva, mas a máquina ainda precisava dessa aplicação pela interface. As ferramentas disponíveis nessa preparação permitiam salvar o rascunho, sem executar sua publicação. Não descreva a rede como liberada apenas porque o arquivo contém `unrestricted`.

O controle de rede desse ambiente de desenvolvimento é separado da rede do Worker publicado na Cloudflare e da autenticação exigida pela API de destino.

## Diagnóstico da Evolution Go

```sh
npm run check:evolution
```

O servidor padrão é `https://api.dallan.pro`, com documentação em [Swagger](https://api.dallan.pro/swagger/index.html). O verificador faz consultas somente de leitura à documentação pública e, quando disponível, à especificação Swagger. Ele retorna erro se o acesso necessário falhar; não transforma uma resposta bloqueada em sucesso.

Para consultar também `GET /instance/status`, disponibilize `EVOLUTION_INSTANCE_TOKEN` ao processo por um canal seguro, como as configurações de credenciais do ambiente. Não coloque o valor em argumentos de comandos, no código ou no chat. O diagnóstico não exibe o token, não gera QR Code, não reinicia a instância e não envia mensagens.

Um erro `CONNECT 403` retornado pelo proxy significa que a conexão foi bloqueada antes de chegar à API. Nesse caso, aplique a configuração de rede na plataforma e repita o diagnóstico com uma conexão nova. Documentação acessível não comprova token válido; status consultado não comprova entrega de uma notificação.

`EVOLUTION_INSTANCE_TOKEN` é uma opção do diagnóstico, sem associação automática às arenas de produção. Cada mãe ou filho mantém sua própria conexão em **Meu sistema → Notificações WhatsApp**. Cadastre o token da instância no painel e use **Conectar WhatsApp** para o pareamento por QR Code. As credenciais não são copiadas ao criar filhos.

## Arquivos locais e dados privados

Mantenha tokens, bancos, comprovantes, QR Codes de pareamento, `.env`, `.dev.vars`, `node_modules` e `.wrangler` fora dos commits. Os scripts e a configuração versionada contêm instruções e opções públicas; valores de credenciais devem continuar nos canais seguros e no banco privado de cada arena.
