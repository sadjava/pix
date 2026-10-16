-- Current rug row per project. The client uses only the anon/publishable key.
-- The service key stays off the client.

create table if not exists public.rugs (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  schema_version integer not null,
  document_revision bigint not null,
  updated_at timestamptz not null,
  palette jsonb not null,
  cells text not null,
  grid_visible boolean not null,
  checker_visible boolean not null,
  checker_block integer not null,
  symmetry jsonb not null,
  content_hash text not null
);

alter table public.rugs enable row level security;

create policy rugs_select
  on public.rugs
  for select
  to authenticated
  using (owner_id = auth.uid());

create policy rugs_insert
  on public.rugs
  for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy rugs_update
  on public.rugs
  for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy rugs_delete
  on public.rugs
  for delete
  to authenticated
  using (owner_id = auth.uid());
