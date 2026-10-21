# DELTA CNC — Controle de Visitas

Aplicação interna da produção para organizar informações de visitas de clientes recebidas do comercial.

## Fluxo interno

- A produção abre **Preencher com IA**, cola a mensagem recebida ou seleciona um PDF.
- O Gemini sugere os campos de cliente, linha, máquina, material, espessura/dimensões, data, horário e observações.
- A produção revisa e corrige os campos no formulário antes de encaminhar para validação fabril.
- Outro Editor responsável pela linha ou um Administrador aprova, recusa com motivo obrigatório ou sugere uma nova data/horário; o autor do pedido não aprova o próprio registro.
- O comercial não recebe contas para este app; os perfis são Administrador e Editor vinculado a uma linha.
- O Administrador cria, redefine e remove as contas dos Editores dentro do app, informando e-mail e senha. A Edge Function cria o usuário no Supabase Auth com e-mail já confirmado, sem fluxo de confirmação Gmail.

A IA não salva registros automaticamente. Texto e PDF selecionados são enviados ao Google Gemini para processamento. Use apenas material que a DELTA esteja autorizada a compartilhar com esse serviço. `GEMINI_API_KEY` fica somente nos secrets do servidor Supabase e nunca no navegador.

## Configuração

Use um projeto Supabase exclusivo para o Controle de Visitas.

1. O projeto dedicado já tem `public.visits`, `public.visits_user_roles`, RLS, trigger de validação e bucket privado temporário.
2. Execute `SUPABASE_EDITOR_ROLE_MIGRATION.sql` após mudanças do modelo de papéis para converter perfis `Fábrica` antigos em `Editor`, preservando as linhas.
3. As Edge Functions `visits-admin-users` e `visits-read-intake` estão publicadas no projeto dedicado. No GitHub, o código fonte delas fica em `supabase/functions/`.
4. Em **Edge Functions > Secrets**, mantenha `VISITS_PRIMARY_ADMIN_EMAIL` definido para o e-mail do administrador principal e adicione `GEMINI_API_KEY` quando a chave do Google AI Studio estiver pronta. Nunca coloque segredos no navegador ou no GitHub. As variáveis internas do Supabase são fornecidas automaticamente pelas Edge Functions.
5. Abra **Conectar Supabase** em cada dispositivo e informe Project URL e Publishable/anon key do projeto DELTA CNC - Controle de Visitas.
6. O administrador inicial autentica-se com a conta criada em Supabase Auth e completa a confirmação inicial do convite. Depois, cria e redefine contas Editor em **Acessos**, informando e-mail e senha; a Edge Function define `email_confirm: true`, portanto os Editores não precisam confirmar pelo Gmail.

A migração torna a leitura de visitas autenticada, mantém registros antigos e cria o bucket privado temporário `visits-ai-inbox`, limitado a PDFs de 4 MB. A função remove os PDFs depois da leitura e a policy permite ao navegador apagar seu próprio arquivo temporário se a chamada falhar. O projeto Controle de Produção e seu repositório permanecem separados e não são alterados por este app.

## Teste local

Use um servidor estático, como `npx serve .`. O modo local é apenas para experimentar neste navegador; ele não fornece isolamento por usuário ou aprovação compartilhada.