# DELTA CNC — Controle de Visitas

Aplicação interna da produção para organizar informações de visitas de clientes recebidas do comercial.

## Fluxo interno

- A produção abre **Preencher com IA**, cola a mensagem recebida ou seleciona um PDF.
- O Gemini sugere os campos de cliente, linha, máquina, material, espessura/dimensões, data, horário e observações.
- A produção revisa e corrige os campos no formulário antes de encaminhar para validação fabril.
- Outro Editor responsável pela linha ou um Administrador aprova, recusa com motivo obrigatório ou sugere uma nova data/horário; o autor do pedido não aprova o próprio registro.
- O comercial não recebe contas para este app; os perfis são Administrador e Editor vinculado a uma linha.
- O Administrador cria, redefine e remove as contas dos Editores dentro do app, informando e-mail e senha. A Edge Function cria o usuário no Supabase Auth com e-mail já confirmado, sem fluxo de confirmação Gmail.

A IA não salva registros automaticamente. Texto e PDF selecionados são enviados ao Google Gemini para processamento. Use apenas material que a DELTA esteja autorizada a compartilhar com esse serviço. A chave Gemini é guardada no armazenamento local do navegador; evite usá-la em computadores compartilhados.

## Configuração

Use um projeto Supabase exclusivo para o Controle de Visitas.

1. No Supabase correto, execute `SUPABASE_SETUP.sql` se `public.visits` ainda não existir.
2. Crie a conta corporativa do administrador inicial em **Authentication > Users**.
3. Execute `SUPABASE_VISITS_MIGRATION.sql`, configurando o e-mail do administrador no bloco bootstrap ao final.
4. Em **Edge Functions > Secrets**, configure `SUPABASE_SERVICE_ROLE_KEY`, `VISITS_PRIMARY_ADMIN_EMAIL` e `GEMINI_API_KEY`. Nunca coloque nenhuma dessas chaves no navegador ou no GitHub.
5. Publique as funções com `supabase functions deploy visits-admin-users --project-ref SEU_PROJECT_REF` e `supabase functions deploy visits-read-intake --project-ref SEU_PROJECT_REF`.
6. Abra **Conectar Supabase** em cada dispositivo e informe Project URL e Publishable/anon key.
7. Execute `SUPABASE_EDITOR_ROLE_MIGRATION.sql` para converter contas `Fábrica` antigas em `Editor`, preservando a linha.
8. Para o primeiro Administrador, crie a conta no Supabase Auth com uma senha forte digitada diretamente no painel e confirme o e-mail uma única vez. Depois, entre no app; o Administrador cria e redefine contas Editor em **Acessos**, com e-mail e senha definidos ali, sem convite ou confirmação Gmail.
9. A função `visits-read-intake` usa `GEMINI_API_KEY` apenas no servidor. A chave não é solicitada nem armazenada no navegador.

A migração torna a leitura de visitas autenticada, mantém registros antigos e cria o bucket privado temporário `visits-ai-inbox`, limitado a PDFs de 4 MB. A função remove os PDFs depois da leitura e a policy permite ao navegador apagar seu próprio arquivo temporário se a chamada falhar. Revise o SQL antes de executar e confirme que o projeto selecionado é o do Controle de Visitas.

## Teste local

Use um servidor estático, como `npx serve .`. O modo local é apenas para experimentar neste navegador; ele não fornece isolamento por usuário ou aprovação compartilhada.