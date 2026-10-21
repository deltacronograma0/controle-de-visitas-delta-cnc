-- Execute no SQL Editor do Supabase (projeto NOVO, separado do app de estoque).
-- Depois crie os usuários em Authentication > Users.

create table if not exists public.visits (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.visits enable row level security;

drop policy if exists "visits public read" on public.visits;
drop policy if exists "visits auth write" on public.visits;

create policy "visits public read" on public.visits
  for select to anon, authenticated using (true);

create policy "visits auth write" on public.visits
  for all to authenticated using (true) with check (true);

grant select on public.visits to anon, authenticated;
grant insert, update, delete on public.visits to authenticated;

alter publication supabase_realtime add table public.visits;
