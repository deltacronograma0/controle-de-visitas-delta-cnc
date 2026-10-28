-- Habilita contas Vendas por linha e fixa os responsaveis oficiais no Supabase.
-- Execute no projeto Supabase exclusivo do Controle de Visitas.

begin;

create or replace function public.visits_line_responsibles(line_name text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case line_name
    when 'Linha Leve' then jsonb_build_object('commercialResponsible', 'Michel - Vendas - SP', 'factoryResponsible', 'André - Fábrica')
    when 'Linha Intermediária' then jsonb_build_object('commercialResponsible', 'Gustavo - Vendas - SP', 'factoryResponsible', 'Pedro Mendes - Fábrica')
    when 'Linha Pesada' then jsonb_build_object('commercialResponsible', 'Victor - Vendas - SP', 'factoryResponsible', 'Leonardo e Ana - Fábrica')
    else '{}'::jsonb
  end;
$$;
revoke all on function public.visits_line_responsibles(text) from public, anon, authenticated;

alter table public.visits_user_roles drop constraint if exists visits_user_roles_role_check;
alter table public.visits_user_roles drop constraint if exists visits_editor_requires_line;
alter table public.visits_user_roles add constraint visits_user_roles_role_check
  check (role in ('Administrador', 'Editor', 'Vendas'));
alter table public.visits_user_roles add constraint visits_editor_requires_line check (
  (role in ('Editor', 'Vendas') and line in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada'))
  or (role = 'Administrador' and line is null)
);
do $$
begin
  if exists (
    select 1 from public.visits_user_roles
    where role = 'Vendas'
    group by line having count(*) > 1
  ) then
    raise exception 'Existe mais de uma conta Vendas em alguma linha. Mantenha somente o responsavel comercial fixo antes de executar esta migracao.';
  end if;
end;
$$;
create unique index if not exists visits_one_sales_scheduler_per_line
  on public.visits_user_roles(line) where role = 'Vendas';

drop policy if exists "visits authenticated read" on public.visits;
drop policy if exists "visits request insert" on public.visits;
drop policy if exists "visits controlled update" on public.visits;

create policy "visits authenticated read" on public.visits
  for select to authenticated using (
    public.visits_has_role('Administrador')
    or public.visits_has_role('Editor', data->>'line')
    or public.visits_has_role('Vendas', data->>'line')
  );
create policy "visits request insert" on public.visits
  for insert to authenticated
  with check (
    public.visits_has_role('Administrador')
    or public.visits_has_role('Vendas', data->>'line')
  );
create policy "visits controlled update" on public.visits
  for update to authenticated
  using (
    public.visits_has_role('Administrador')
    or (public.visits_has_role('Editor', data->>'line')
      and coalesce(data->>'approvalStatus', 'Aprovada') in ('Pendente', 'Aprovada'))
    or (public.visits_has_role('Vendas', data->>'line')
      and coalesce(data->>'approvalStatus', 'Aprovada') in ('Pendente', 'Recusada', 'Nova data sugerida')
      and lower(coalesce(data->>'requestedByEmail', '')) = lower(auth.jwt()->>'email'))
  )
  with check (
    public.visits_has_role('Administrador')
    or public.visits_has_role('Editor', data->>'line')
    or public.visits_has_role('Vendas', data->>'line')
  );

create or replace function public.visits_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  actor_email text := lower(coalesce(auth.jwt()->>'email', ''));
  old_approval text;
  new_approval text;
  schedule_changed boolean;
begin
  if actor_email = '' then raise exception 'Autenticacao necessaria.'; end if;

  new.data := new.data || public.visits_line_responsibles(new.data->>'line');
  if jsonb_typeof(coalesce(new.data->'salesParticipants', '[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(new.data->'factoryParticipants', '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Lista de acompanhantes invalida.';
  end if;
  if jsonb_array_length(coalesce(new.data->'salesParticipants', '[]'::jsonb)) > 20
    or jsonb_array_length(coalesce(new.data->'factoryParticipants', '[]'::jsonb)) > 20 then
    raise exception 'Cada lista de acompanhantes aceita no maximo 20 pessoas.';
  end if;
  new.data := jsonb_set(new.data, '{salesParticipants}', coalesce(new.data->'salesParticipants', '[]'::jsonb), true);
  new.data := jsonb_set(new.data, '{factoryParticipants}', coalesce(new.data->'factoryParticipants', '[]'::jsonb), true);

  if tg_op = 'INSERT' then
    if not (public.visits_has_role('Administrador') or public.visits_has_role('Vendas')) then
      raise exception 'Somente o responsavel comercial da linha pode solicitar testes.';
    end if;
    if public.visits_has_role('Vendas') and not public.visits_has_role('Vendas', new.data->>'line') then
      raise exception 'Voce so pode solicitar testes para a sua linha.';
    end if;
    if public.visits_has_role('Vendas') then
      new.data := jsonb_set(new.data, '{factoryParticipants}', '[]'::jsonb, true);
    end if;
    if coalesce(new.data->>'testType', 'Demonstração com cliente') not in ('Interno', 'Demonstração com cliente') then
      raise exception 'Tipo de teste invalido.';
    end if;
    if coalesce(new.data->>'testType', 'Demonstração com cliente') = 'Demonstração com cliente'
      and (nullif(trim(new.data->>'client'), '') is null or nullif(trim(new.data->>'company'), '') is null) then
      raise exception 'Informe o nome do cliente e a empresa para demonstracoes.';
    end if;
    if coalesce(new.data->>'line', '') not in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada')
      or nullif(trim(new.data->>'machineRequested'), '') is null
      or nullif(trim(new.data->>'material'), '') is null
      or nullif(new.data->>'date', '') is null
      or nullif(new.data->>'time', '') is null then
      raise exception 'Linha, maquina, material, data e horario sao obrigatorios.';
    end if;
    new.data := jsonb_set(new.data, '{testType}', to_jsonb(coalesce(new.data->>'testType', 'Demonstração com cliente')), true);
    new.data := jsonb_set(new.data, '{approvalStatus}', '"Pendente"'::jsonb, true);
    new.data := jsonb_set(new.data, '{requestedByEmail}', to_jsonb(actor_email), true);
    new.data := jsonb_set(new.data, '{requestedByName}', to_jsonb(actor_email), true);
    new.data := jsonb_set(new.data, '{requestedAt}', to_jsonb(now()::text), true);
    new.data := jsonb_set(new.data, '{approvalReason}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{factoryNote}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{suggestedDate}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{suggestedTime}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{reviewedByEmail}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{reviewedAt}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{preparationChecklist}', '[]'::jsonb, true);
    new.data := jsonb_set(new.data, '{testPreparationNotes}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{testResult}', '""'::jsonb, true);
    if coalesce(new.data->>'testType', 'Demonstração com cliente') = 'Interno' then
      new.data := jsonb_set(new.data, '{client}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{company}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{phone}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{host}', '""'::jsonb, true);
    end if;
    new.data := new.data - 'checkIn' - 'checkOut';
    new.data := jsonb_set(new.data, '{status}', '"Agendada"'::jsonb, true);
    return new;
  end if;

  if new.data->>'status' = 'Concluída' and nullif(trim(new.data->>'testResult'), '') is null then
    raise exception 'Registre o resultado antes de concluir o teste.';
  end if;
  if public.visits_has_role('Administrador') then return new; end if;
  old_approval := coalesce(old.data->>'approvalStatus', 'Aprovada');
  new_approval := coalesce(new.data->>'approvalStatus', 'Aprovada');

  if public.visits_has_role('Vendas', old.data->>'line') then
    if old_approval not in ('Pendente', 'Recusada', 'Nova data sugerida')
      or lower(coalesce(old.data->>'requestedByEmail', '')) <> actor_email
      or new.data->>'line' is distinct from old.data->>'line' then
      raise exception 'Vendas so pode alterar os proprios pedidos ainda nao aprovados da sua linha.';
    end if;
    if coalesce(new.data->'factoryParticipants', '[]'::jsonb)
      is distinct from coalesce(old.data->'factoryParticipants', '[]'::jsonb) then
      raise exception 'Somente a producao pode definir os acompanhantes da fabrica.';
    end if;
    if (new.data - array['client','company','phone','testType','line','commercialResponsible','factoryResponsible','salesParticipants','machineRequested','material','materialThickness','host','date','time','reason','notes','requestedByEmail','requestedByName','requestedAt','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt'])
      <> (old.data - array['client','company','phone','testType','line','commercialResponsible','factoryResponsible','salesParticipants','machineRequested','material','materialThickness','host','date','time','reason','notes','requestedByEmail','requestedByName','requestedAt','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt']) then
      raise exception 'Nao e permitido alterar dados fora do pedido de teste.';
    end if;
    if coalesce(new.data->>'testType', 'Demonstração com cliente') not in ('Interno', 'Demonstração com cliente')
      or (coalesce(new.data->>'testType', 'Demonstração com cliente') = 'Demonstração com cliente'
        and (nullif(trim(new.data->>'client'), '') is null or nullif(trim(new.data->>'company'), '') is null))
      or coalesce(new.data->>'line', '') not in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada')
      or nullif(trim(new.data->>'machineRequested'), '') is null
      or nullif(trim(new.data->>'material'), '') is null
      or nullif(new.data->>'date', '') is null
      or nullif(new.data->>'time', '') is null then
      raise exception 'Confira tipo, cliente, linha, maquina, material, data e horario.';
    end if;
    new.data := jsonb_set(new.data, '{approvalStatus}', '"Pendente"'::jsonb, true);
    new.data := jsonb_set(new.data, '{requestedByEmail}', to_jsonb(actor_email), true);
    new.data := jsonb_set(new.data, '{requestedByName}', to_jsonb(actor_email), true);
    new.data := jsonb_set(new.data, '{requestedAt}', to_jsonb(now()::text), true);
    new.data := jsonb_set(new.data, '{approvalReason}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{factoryNote}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{suggestedDate}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{suggestedTime}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{reviewedByEmail}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{reviewedAt}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{status}', '"Agendada"'::jsonb, true);
    new.data := jsonb_set(new.data, '{preparationChecklist}', '[]'::jsonb, true);
    new.data := jsonb_set(new.data, '{testPreparationNotes}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{testResult}', '""'::jsonb, true);
    new.data := new.data - 'checkIn' - 'checkOut';
    return new;
  end if;

  if public.visits_has_role('Editor', old.data->>'line') then
    if old_approval = 'Pendente' and lower(old.data->>'requestedByEmail') = actor_email then
      if (new.data - array['client','company','phone','testType','line','commercialResponsible','factoryResponsible','salesParticipants','factoryParticipants','machineRequested','material','materialThickness','host','date','time','reason','notes','requestedByEmail','requestedByName','requestedAt','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt','preparationChecklist','testPreparationNotes','testResult'])
        <> (old.data - array['client','company','phone','testType','line','commercialResponsible','factoryResponsible','salesParticipants','factoryParticipants','machineRequested','material','materialThickness','host','date','time','reason','notes','requestedByEmail','requestedByName','requestedAt','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt','preparationChecklist','testPreparationNotes','testResult']) then
        raise exception 'Nao e permitido alterar dados tecnicos durante a validacao fabril.';
      end if;
      if coalesce(new.data->>'testType', 'Demonstração com cliente') not in ('Interno', 'Demonstração com cliente')
        or (coalesce(new.data->>'testType', 'Demonstração com cliente') = 'Demonstração com cliente'
          and (nullif(trim(new.data->>'client'), '') is null or nullif(trim(new.data->>'company'), '') is null))
        or coalesce(new.data->>'line', '') not in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada')
        or nullif(trim(new.data->>'machineRequested'), '') is null
        or nullif(trim(new.data->>'material'), '') is null
        or nullif(new.data->>'date', '') is null
        or nullif(new.data->>'time', '') is null then
        raise exception 'Confira tipo, cliente, linha, maquina, material, data e horario.';
      end if;
      new.data := jsonb_set(new.data, '{approvalStatus}', '"Pendente"'::jsonb, true);
      new.data := jsonb_set(new.data, '{requestedAt}', to_jsonb(now()::text), true);
      new.data := jsonb_set(new.data, '{approvalReason}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{factoryNote}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{suggestedDate}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{suggestedTime}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{reviewedByEmail}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{reviewedAt}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{status}', '"Agendada"'::jsonb, true);
      new.data := jsonb_set(new.data, '{preparationChecklist}', '[]'::jsonb, true);
      new.data := jsonb_set(new.data, '{testPreparationNotes}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{testResult}', '""'::jsonb, true);
      new.data := new.data - 'checkIn' - 'checkOut';
      return new;
    end if;

    if old_approval = 'Pendente' and lower(coalesce(old.data->>'requestedByEmail', '')) <> actor_email then
      if (new.data - array['approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt'])
        <> (old.data - array['approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt']) then
        raise exception 'Fabrica so pode registrar a decisao do teste.';
      end if;
      if new_approval not in ('Aprovada', 'Recusada', 'Nova data sugerida') then
        raise exception 'Decisao invalida.';
      end if;
      if new_approval = 'Recusada' and nullif(trim(new.data->>'approvalReason'), '') is null then
        raise exception 'Informe o motivo da recusa.';
      end if;
      if new_approval = 'Nova data sugerida' and (nullif(new.data->>'suggestedDate', '') is null or nullif(new.data->>'suggestedTime', '') is null) then
        raise exception 'Informe a data e o horario sugeridos.';
      end if;
      new.data := jsonb_set(new.data, '{reviewedByEmail}', to_jsonb(actor_email), true);
      new.data := jsonb_set(new.data, '{reviewedAt}', to_jsonb(now()::text), true);
      return new;
    end if;

    if old_approval = 'Aprovada'
      and (new.data - array['status','checkIn','checkOut','preparationChecklist','testPreparationNotes','testResult','testType','client','company','phone','machineRequested','material','materialThickness','host','date','time','reason','notes','commercialResponsible','factoryResponsible','factoryParticipants','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt','requestedAt'])
        = (old.data - array['status','checkIn','checkOut','preparationChecklist','testPreparationNotes','testResult','testType','client','company','phone','machineRequested','material','materialThickness','host','date','time','reason','notes','commercialResponsible','factoryResponsible','factoryParticipants','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt','requestedAt']) then
      if coalesce(new.data->>'status', '') not in ('Agendada', 'Preparação', 'Em andamento', 'Concluída', 'Cancelada', 'Não compareceu') then
        raise exception 'Etapa de teste invalida.';
      end if;
      if jsonb_typeof(coalesce(new.data->'preparationChecklist', '[]'::jsonb)) <> 'array'
        or jsonb_array_length(coalesce(new.data->'preparationChecklist', '[]'::jsonb)) > 5 then
        raise exception 'Checklist de preparacao invalido.';
      end if;
      if length(coalesce(new.data->>'testPreparationNotes', '')) > 1000
        or length(coalesce(new.data->>'testResult', '')) > 2000 then
        raise exception 'O registro de preparacao ou resultado excede o limite.';
      end if;
      if coalesce(new.data->>'testType', 'Demonstração com cliente') not in ('Interno', 'Demonstração com cliente')
        or (coalesce(new.data->>'testType', 'Demonstração com cliente') = 'Demonstração com cliente'
          and (nullif(trim(new.data->>'client'), '') is null or nullif(trim(new.data->>'company'), '') is null))
        or nullif(new.data->>'machineRequested', '') is null
        or nullif(new.data->>'material', '') is null
        or nullif(new.data->>'date', '') is null
        or nullif(new.data->>'time', '') is null then
        raise exception 'Confira tipo, cliente, maquina, material, data e horario do teste.';
      end if;
      schedule_changed := new.data->>'testType' is distinct from old.data->>'testType'
        or new.data->>'client' is distinct from old.data->>'client'
        or new.data->>'company' is distinct from old.data->>'company'
        or new.data->>'phone' is distinct from old.data->>'phone'
        or new.data->>'machineRequested' is distinct from old.data->>'machineRequested'
        or new.data->>'material' is distinct from old.data->>'material'
        or new.data->>'materialThickness' is distinct from old.data->>'materialThickness'
        or coalesce(new.data->'salesParticipants', '[]'::jsonb) is distinct from coalesce(old.data->'salesParticipants', '[]'::jsonb)
        or new.data->>'host' is distinct from old.data->>'host'
        or new.data->>'date' is distinct from old.data->>'date'
        or new.data->>'time' is distinct from old.data->>'time'
        or new.data->>'reason' is distinct from old.data->>'reason';
      if schedule_changed then
        new.data := jsonb_set(new.data, '{approvalStatus}', '"Pendente"'::jsonb, true);
        new.data := jsonb_set(new.data, '{requestedAt}', to_jsonb(now()::text), true);
        new.data := jsonb_set(new.data, '{status}', '"Agendada"'::jsonb, true);
        new.data := jsonb_set(new.data, '{reviewedByEmail}', '""'::jsonb, true);
        new.data := jsonb_set(new.data, '{reviewedAt}', '""'::jsonb, true);
        new.data := jsonb_set(new.data, '{approvalReason}', '""'::jsonb, true);
        new.data := jsonb_set(new.data, '{factoryNote}', '""'::jsonb, true);
        new.data := new.data - 'checkIn' - 'checkOut';
      elsif new.data->>'approvalStatus' is distinct from old.data->>'approvalStatus'
        or new.data->>'approvalReason' is distinct from old.data->>'approvalReason'
        or new.data->>'reviewedByEmail' is distinct from old.data->>'reviewedByEmail'
        or new.data->>'reviewedAt' is distinct from old.data->>'reviewedAt' then
        raise exception 'Apenas a fabrica pode alterar a decisao de aprovacao.';
      end if;
      return new;
    end if;
  end if;

  raise exception 'Voce nao tem permissao para alterar este teste.';
end;
$$;

alter table public.visits disable trigger visits_guard_change;
update public.visits
set data = data || public.visits_line_responsibles(data->>'line')
where data->>'line' in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada');
alter table public.visits enable trigger visits_guard_change;

commit;
