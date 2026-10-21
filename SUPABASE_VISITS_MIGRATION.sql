-- Execute somente no projeto Supabase exclusivo do Controle de Visitas.
-- Crie primeiro no Authentication o e-mail do administrador inicial e depois
-- substitua o exemplo abaixo pelo e-mail real antes de executar a inserção.

begin;

create table if not exists public.visits_user_roles (
  email text primary key,
  role text not null check (role in ('Administrador', 'Fábrica')),
  line text,
  created_at timestamptz not null default now(),
  constraint visits_factory_requires_line check (
    (role = 'Fábrica' and line in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada'))
    or (role <> 'Fábrica' and line is null)
  )
);

alter table public.visits_user_roles enable row level security;
revoke all on public.visits_user_roles from anon, authenticated, public;
grant select on public.visits_user_roles to authenticated;

create or replace function public.visits_has_role(required_role text, required_line text default null)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select exists (
    select 1 from public.visits_user_roles roles
    where lower(roles.email) = lower(auth.jwt()->>'email')
      and roles.role = required_role
      and (required_line is null or roles.line = required_line)
  );
$$;

revoke all on function public.visits_has_role(text, text) from public;
grant execute on function public.visits_has_role(text, text) to authenticated;

drop policy if exists "visits roles self or admin read" on public.visits_user_roles;
create policy "visits roles self or admin read" on public.visits_user_roles
  for select to authenticated
  using (lower(email) = lower(auth.jwt()->>'email') or public.visits_has_role('Administrador'));

alter table public.visits enable row level security;
revoke all on public.visits from anon, public;
grant select, insert, update, delete on public.visits to authenticated;

drop policy if exists "visits public read" on public.visits;
drop policy if exists "visits auth write" on public.visits;
drop policy if exists "visits authenticated read" on public.visits;
drop policy if exists "visits request insert" on public.visits;
drop policy if exists "visits controlled update" on public.visits;
drop policy if exists "visits admin delete" on public.visits;

create policy "visits authenticated read" on public.visits
  for select to authenticated using (
    public.visits_has_role('Administrador')
    or public.visits_has_role('Fábrica', data->>'line')
  );

create policy "visits request insert" on public.visits
  for insert to authenticated
  with check (public.visits_has_role('Administrador') or public.visits_has_role('Fábrica'));

create policy "visits controlled update" on public.visits
  for update to authenticated
  using (
    public.visits_has_role('Administrador')
    or (public.visits_has_role('Fábrica', data->>'line')
      and coalesce(data->>'approvalStatus', 'Aprovada') in ('Pendente', 'Aprovada'))
  )
  with check (
    public.visits_has_role('Administrador')
    or public.visits_has_role('Fábrica', data->>'line')
  );

create policy "visits admin delete" on public.visits
  for delete to authenticated using (public.visits_has_role('Administrador'));

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
begin
  if actor_email = '' then raise exception 'Autenticação necessária.'; end if;

  if tg_op = 'INSERT' then
    if not (public.visits_has_role('Administrador') or public.visits_has_role('Fábrica')) then
      raise exception 'Somente a equipe de produção pode registrar pedidos.';
    end if;
    if public.visits_has_role('Fábrica') and not public.visits_has_role('Fábrica', new.data->>'line') then
      raise exception 'Você só pode registrar pedidos para a sua linha fabril.';
    end if;
    if new.data->>'line' not in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada')
      or nullif(new.data->>'machineRequested', '') is null
      or nullif(new.data->>'material', '') is null
      or nullif(new.data->>'date', '') is null
      or nullif(new.data->>'time', '') is null then
      raise exception 'Linha, máquina, material, data e horário são obrigatórios.';
    end if;
    new.data := jsonb_set(new.data, '{approvalStatus}', '"Pendente"'::jsonb, true);
    new.data := jsonb_set(new.data, '{requestedByEmail}', to_jsonb(actor_email), true);
    new.data := jsonb_set(new.data, '{requestedAt}', to_jsonb(now()::text), true);
    new.data := jsonb_set(new.data, '{approvalReason}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{factoryNote}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{suggestedDate}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{suggestedTime}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{reviewedByEmail}', '""'::jsonb, true);
    new.data := jsonb_set(new.data, '{reviewedAt}', '""'::jsonb, true);
    new.data := new.data - 'checkIn' - 'checkOut';
    new.data := jsonb_set(new.data, '{status}', '"Agendada"'::jsonb, true);
    return new;
  end if;

  if public.visits_has_role('Administrador') then return new; end if;
  old_approval := coalesce(old.data->>'approvalStatus', 'Aprovada');
  new_approval := coalesce(new.data->>'approvalStatus', 'Aprovada');

  if public.visits_has_role('Fábrica', old.data->>'line') then
    if old_approval = 'Pendente' and lower(old.data->>'requestedByEmail') = actor_email then
      if (new.data - array['client','company','phone','line','commercialResponsible','factoryResponsible','machineRequested','material','materialThickness','host','date','time','reason','notes','requestedByEmail','requestedByName','requestedAt','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt'])
        <> (old.data - array['client','company','phone','line','commercialResponsible','factoryResponsible','machineRequested','material','materialThickness','host','date','time','reason','notes','requestedByEmail','requestedByName','requestedAt','approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt']) then
        raise exception 'Não é permitido alterar dados técnicos durante a validação fabril.';
      end if;
      if new.data->>'line' not in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada')
        or nullif(new.data->>'machineRequested', '') is null
        or nullif(new.data->>'material', '') is null
        or nullif(new.data->>'date', '') is null
        or nullif(new.data->>'time', '') is null then
        raise exception 'Linha, máquina, material, data e horário são obrigatórios.';
      end if;
      new.data := jsonb_set(new.data, '{approvalStatus}', '"Pendente"'::jsonb, true);
      new.data := jsonb_set(new.data, '{requestedAt}', to_jsonb(now()::text), true);
      new.data := jsonb_set(new.data, '{approvalReason}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{factoryNote}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{suggestedDate}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{suggestedTime}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{reviewedByEmail}', '""'::jsonb, true);
      new.data := jsonb_set(new.data, '{reviewedAt}', '""'::jsonb, true);
      return new;
    end if;
    if old_approval = 'Pendente' and lower(coalesce(old.data->>'requestedByEmail', '')) <> actor_email then
      if (new.data - array['approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt'])
        <> (old.data - array['approvalStatus','approvalReason','factoryNote','suggestedDate','suggestedTime','reviewedByEmail','reviewedAt']) then
        raise exception 'Fábrica só pode registrar a decisão do pedido.';
      end if;
      if new_approval not in ('Aprovada', 'Recusada', 'Nova data sugerida') then
        raise exception 'Decisão inválida.';
      end if;
      if new_approval = 'Recusada' and nullif(trim(new.data->>'approvalReason'), '') is null then
        raise exception 'Informe o motivo da recusa.';
      end if;
      if new_approval = 'Nova data sugerida' and (nullif(new.data->>'suggestedDate', '') is null or nullif(new.data->>'suggestedTime', '') is null) then
        raise exception 'Informe a data e o horário sugeridos.';
      end if;
      new.data := jsonb_set(new.data, '{reviewedByEmail}', to_jsonb(actor_email), true);
      new.data := jsonb_set(new.data, '{reviewedAt}', to_jsonb(now()::text), true);
      return new;
    end if;
    if old_approval = 'Aprovada' and (new.data - array['status','checkIn','checkOut']) = (old.data - array['status','checkIn','checkOut']) then
      return new;
    end if;
  end if;

  raise exception 'Você não tem permissão para alterar esta solicitação.';
end;
$$;

drop trigger if exists visits_guard_change on public.visits;
create trigger visits_guard_change before insert or update on public.visits
  for each row execute function public.visits_guard_change();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visits-ai-inbox', 'visits-ai-inbox', false, 4194304, array['application/pdf'])
on conflict (id) do update
set public = false, file_size_limit = 4194304, allowed_mime_types = array['application/pdf'];

drop policy if exists "visits ai upload own pdf" on storage.objects;
create policy "visits ai upload own pdf" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'visits-ai-inbox'
    and (storage.foldername(name))[1] = 'ai-imports'
    and lower((storage.foldername(name))[2]) = lower(auth.jwt()->>'email')
    and (public.visits_has_role('Administrador') or public.visits_has_role('Fábrica'))
  );

drop policy if exists "visits ai delete own pdf" on storage.objects;
create policy "visits ai delete own pdf" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'visits-ai-inbox'
    and (storage.foldername(name))[1] = 'ai-imports'
    and lower((storage.foldername(name))[2]) = lower(auth.jwt()->>'email')
    and (public.visits_has_role('Administrador') or public.visits_has_role('Fábrica'))
  );

-- Bootstrap: execute após criar a conta no Authentication, substituindo o e-mail.
-- insert into public.visits_user_roles(email, role, line)
-- values (lower('admin@empresa.com'), 'Administrador', null)
-- on conflict (email) do update set role = 'Administrador', line = null;

commit;