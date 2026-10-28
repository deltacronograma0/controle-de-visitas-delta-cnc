# DELTA CNC — Controle de Visitas

Aplicação interna da produção para organizar testes de máquina, tanto internos quanto demonstrações com clientes.

## Fluxo interno

- Cada teste é classificado como **Interno, sem cliente** ou **Demonstração com cliente**. Os dados do cliente só são obrigatórios para demonstrações.
- Em demonstrações, o pedido exige a pessoa que atenderá o cliente; os responsáveis comerciais e da produção são preenchidos automaticamente pela linha e não podem ser alterados no teste.
- Usuários de Vendas vinculados à linha podem abrir pedidos e corrigir os próprios pedidos enquanto não forem aprovados. O e-mail do solicitante fica registrado separadamente do responsável comercial fixo.
- O responsável comercial da linha ou o Administrador abre **Preencher com IA**, cola a mensagem recebida ou seleciona um PDF.
- O Gemini sugere os campos de cliente, linha, máquina, material, espessura/dimensões, data, horário e observações.
- O responsável comercial revisa e corrige os campos no formulário antes de encaminhar para validação fabril.
- Outro Editor responsável pela linha ou um Administrador aprova, recusa com motivo obrigatório ou sugere uma nova data/horário; o autor do pedido não aprova o próprio registro.
- Após a aprovação, o responsável acompanha **Agendado → Preparação → Em andamento → Concluído**, registra checklist, pendências e resultado. O teste não pode ser concluído sem resultado.
- A agenda mensal separa visualmente testes internos e demonstrações, e destaca os testes de hoje, em preparação e atrasados.
- Os nomes do responsável comercial e do responsável da produção são preenchidos manualmente em cada teste; selecionar uma linha não preenche nomes padrão. Na Linha Pesada, Leonardo e Ana podem ser escritos juntos como responsáveis da produção, se forem acompanhar.
- Cada linha tem uma única conta Vendas autorizada a agendar. O e-mail do solicitante fica registrado separadamente dos nomes escritos no pedido. Essa conta pode corrigir os próprios pedidos não aprovados; aprovação continua restrita ao Editor da linha ou Administrador.
- Outros vendedores podem ser escritos como acompanhantes, em um campo separado dos acompanhantes da produção. Ambos aceitam vários nomes separados por vírgula; informar um nome não concede permissão para agendar.
- Um pedido pode registrar vários acompanhantes da produção; eles não substituem o responsável fixo da linha.
- O Administrador cria, redefine e remove acessos de Editor e Vendas dentro do app, informando e-mail, linha e senha. Há no máximo uma conta Vendas por linha. A Edge Function cria o usuário no Supabase Auth com e-mail já confirmado, sem fluxo de confirmação Gmail.

A IA não salva registros automaticamente. Texto e PDF selecionados são enviados ao Google Gemini para processamento. Use apenas material que a DELTA esteja autorizada a compartilhar com esse serviço. `GEMINI_API_KEY` fica somente nos secrets do servidor Supabase e nunca no navegador.

## Configuração

Use um projeto Supabase exclusivo para o Controle de Visitas.

1. O projeto dedicado já tem `public.visits`, `public.visits_user_roles`, RLS, trigger de validação e bucket privado temporário.
2. Execute `SUPABASE_EDITOR_ROLE_MIGRATION.sql` após mudanças do modelo de papéis para converter perfis `Fábrica` antigos em `Editor`, preservando as linhas.
3. Execute `SUPABASE_TEST_WORKFLOW_MIGRATION.sql` no SQL Editor do projeto para habilitar o tipo de teste e salvar checklist/resultado após a aprovação.
4. Execute `SUPABASE_SALES_ROLE_MIGRATION.sql` no SQL Editor do projeto para habilitar uma conta Vendas agendadora por linha e autorizar as listas de acompanhantes. Os nomes dos responsáveis são digitados em cada teste; a migração não preenche nomes a partir da linha. Vendas não pode aprovar solicitações nem editar testes aprovados.
5. Publique novamente as Edge Functions `visits-admin-users` e `visits-read-intake` após as alterações no código em `supabase/functions/`.
6. Em **Edge Functions > Secrets**, mantenha `VISITS_PRIMARY_ADMIN_EMAIL` definido para o e-mail do administrador principal e `GEMINI_API_KEY` configurada. Nunca coloque segredos no navegador ou no GitHub. As variáveis internas do Supabase são fornecidas automaticamente pelas Edge Functions.
7. Abra **Conectar Supabase** em cada dispositivo e informe Project URL e Publishable/anon key do projeto DELTA CNC - Controle de Visitas.
8. Em **Acessos**, o Administrador cria a conta Vendas responsável e as contas Editor com e-mail, senha e linha. Registre os demais vendedores como acompanhantes do teste.

As visitas legadas sem `testType` continuam sendo tratadas como demonstrações com cliente. Os arquivos `.ics` oferecem alertas quando importados manualmente; o app ainda não envia notificações automáticas quando fechado. O projeto Controle de Produção e seu repositório permanecem separados e não são alterados por este app.

## Teste local

Use um servidor estático, como `npx serve .`. O modo local é apenas para experimentar neste navegador; ele não fornece isolamento por usuário ou aprovação compartilhada.