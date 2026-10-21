-- Execute apenas no projeto Supabase do Controle de Visitas.
-- Converte o perfil anterior Fábrica para Editor, preservando a linha atribuída.
begin;

drop policy if exists "visits authenticated read" on public.visits;
drop policy if exists "visits request insert" on public.visits;
drop policy if exists "visits controlled update" on public.visits;
drop policy if exists "visits ai upload own pdf" on storage.objects;
drop policy if exists "visits ai delete own pdf" on storage.objects;

alter table public.visits_user_roles drop constraint if exists visits_user_roles_role_check;
alter table public.visits_user_roles drop constraint if exists visits_factory_requires_line;
alter table public.visits_user_roles drop constraint if exists visits_editor_requires_line;
update public.visits_user_roles set role = 'Editor' where role = 'Fábrica';
alter table public.visits_user_roles add constraint visits_user_roles_role_check
  check (role in ('Administrador', 'Editor'));
alter table public.visits_user_roles add constraint visits_editor_requires_line check (
  (role = 'Editor' and line in ('Linha Leve', 'Linha Intermediária', 'Linha Pesada'))
  or (role <> 'Editor' and line is null)
);

create policy "visits authenticated read" on public.visits
  for select to authenticated using (
    public.visits_has_role('Administrador')
    or public.visits_has_role('Editor', data->>'line')
  );
create policy "visits request insert" on public.visits
  for insert to authenticated
  with check (public.visits_has_role('Administrador') or public.visits_has_role('Editor'));
create policy "visits controlled update" on public.visits
  for update to authenticated
  using (
    public.visits_has_role('Administrador')
    or (public.visits_has_role('Editor', data->>'line')
      and coalesce(data->>'approvalStatus', 'Aprovada') in ('Pendente', 'Aprovada'))
  )
  with check (
    public.visits_has_role('Administrador')
    or public.visits_has_role('Editor', data->>'line')
  );

do $role_migration$
declare function_definition text;
begin
  select pg_get_functiondef('public.visits_guard_change()'::regprocedure) into function_definition;
  function_definition := replace(function_definition, 'visits_has_role(''Fábrica''', 'visits_has_role(''Editor''');
  function_definition := replace(function_definition, 'Fábrica só pode registrar a decisão do pedido.', 'Editor só pode registrar a decisão do pedido.');
  execute function_definition;
end;
$role_migration$;

create policy "visits ai upload own pdf" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'visits-ai-inbox'
    and (storage.foldername(name))[1] = 'ai-imports'
    and lower((storage.foldername(name))[2]) = lower(auth.jwt()->>'email')
    and (public.visits_has_role('Administrador') or public.visits_has_role('Editor'))
  );
create policy "visits ai delete own pdf" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'visits-ai-inbox'
    and (storage.foldername(name))[1] = 'ai-imports'
    and lower((storage.foldername(name))[2]) = lower(auth.jwt()->>'email')
    and (public.visits_has_role('Administrador') or public.visits_has_role('Editor'))
  );

commit;