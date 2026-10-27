# DELTA CNC — Controle de Visitas

Aplicação interna da produção para organizar testes de máquina, tanto internos quanto demonstrações com clientes.

## Fluxo interno

- Cada teste é classificado como **Interno, sem cliente** ou **Demonstração com cliente**. Os dados do cliente só são obrigatórios para demonstrações.
- Em demonstrações, o agendamento exige vendedora responsável e a pessoa que atenderá o cliente; todo teste exige responsável da produção. A linha sugere nomes padrão, que podem ser ajustados para cada teste.
- A produção abre **Preencher com IA**, cola a mensagem recebida ou seleciona um PDF.
- O Gemini sugere os campos de cliente, linha, máquina, material, espessura/dimensões, data, horário e observações.
- A produção revisa e corrige os campos no formulário antes de encaminhar para validação fabril.
- Outro Editor responsável pela linha ou um Administrador aprova, recusa com motivo obrigatório ou sugere uma nova data/horário; o autor do pedido não aprova o próprio registro.
- Após a aprovação, o responsável acompanha **Agendado → Preparação → Em andamento → Concluído**, registra checklist, pendências e resultado. O teste não pode ser concluído sem resultado.
- A agenda mensal separa visualmente testes internos e demonstrações, e destaca os testes de hoje, em preparação e atrasados.
- O comercial não recebe contas para este app; os perfis são Administrador e Editor vinculado a uma linha.
- O Administrador cria, redefine e remove as contas dos Editores dentro do app, informando e-mail e senha. A Edge Function cria o usuário no Supabase Auth com e-mail já confirmado, sem fluxo de confirmação Gmail.

A IA não salva registros automaticamente. Texto e PDF selecionados são enviados ao Google Gemini para processamento. Use apenas material que a DELTA esteja autorizada a compartilhar com esse serviço. `GEMINI_API_KEY` fica somente nos secrets do servidor Supabase e nunca no navegador.

## Configuração

Use um projeto Supabase exclusivo para o Controle de Visitas.

1. O projeto dedicado já tem `public.visits`, `public.visits_user_roles`, RLS, trigger de validação e bucket privado temporário.
2. Execute `SUPABASE_EDITOR_ROLE_MIGRATION.sql` após mudanças do modelo de papéis para converter perfis `Fábrica` antigos em `Editor`, preservando as linhas.
3. Execute `SUPABASE_TEST_WORKFLOW_MIGRATION.sql` no SQL Editor do projeto para habilitar o tipo de teste e salvar checklist/resultado após a aprovação. A migração mantém as regras de RLS e limita essas atualizações ao Editor da linha ou Administrador.
4. As Edge Functions `visits-admin-users` e `visits-read-intake` estão publicadas no projeto dedicado. No GitHub, o código fonte delas fica em `supabase/functions/`.
5. Em **Edge Functions > Secrets**, mantenha `VISITS_PRIMARY_ADMIN_EMAIL` definido para o e-mail do administrador principal e `GEMINI_API_KEY` configurada. Nunca coloque segredos no navegador ou no GitHub. As variáveis internas do Supabase são fornecidas automaticamente pelas Edge Functions.
6. Abra **Conectar Supabase** em cada dispositivo e informe Project URL e Publishable/anon key do projeto DELTA CNC - Controle de Visitas.
7. O administrador cria e redefine contas Editor em **Acessos**, informando e-mail e senha; a Edge Function confirma a conta automaticamente.

As visitas legadas sem `testType` continuam sendo tratadas como demonstrações com cliente. Os arquivos `.ics` oferecem alertas quando importados manualmente; o app ainda não envia notificações automáticas quando fechado. O projeto Controle de Produção e seu repositório permanecem separados e não são alterados por este app.

## Teste local

Use um servidor estático, como `npx serve .`. O modo local é apenas para experimentar neste navegador; ele não fornece isolamento por usuário ou aprovação compartilhada.