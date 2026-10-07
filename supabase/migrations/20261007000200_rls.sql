-- Row Level Security: every row belongs to exactly one user, and a user can
-- only ever touch their own rows. This is what makes it safe to put the anon
-- key in the browser.
--
-- Each table gets four separate policies (select / insert / update / delete)
-- rather than one "for all" policy, so a mistake can only ever widen one verb,
-- and so the isolation test can drop a single verb to prove it is enforced.
--
-- USING   decides which existing rows you may see or change.
-- WITH CHECK decides which rows you are allowed to leave behind, which is what
-- stops an insert or an update that hands a row to someone else.

-- ---------- ideas ----------

alter table public.ideas enable row level security;

create policy ideas_select_own on public.ideas
  for select to authenticated using (user_id = auth.uid());
create policy ideas_insert_own on public.ideas
  for insert to authenticated with check (user_id = auth.uid());
create policy ideas_update_own on public.ideas
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy ideas_delete_own on public.ideas
  for delete to authenticated using (user_id = auth.uid());

-- ---------- scripts ----------

alter table public.scripts enable row level security;

create policy scripts_select_own on public.scripts
  for select to authenticated using (user_id = auth.uid());
create policy scripts_insert_own on public.scripts
  for insert to authenticated with check (user_id = auth.uid());
create policy scripts_update_own on public.scripts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy scripts_delete_own on public.scripts
  for delete to authenticated using (user_id = auth.uid());

-- ---------- results ----------

alter table public.results enable row level security;

create policy results_select_own on public.results
  for select to authenticated using (user_id = auth.uid());
create policy results_insert_own on public.results
  for insert to authenticated with check (user_id = auth.uid());
create policy results_update_own on public.results
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy results_delete_own on public.results
  for delete to authenticated using (user_id = auth.uid());

-- ---------- trends ----------

alter table public.trends enable row level security;

create policy trends_select_own on public.trends
  for select to authenticated using (user_id = auth.uid());
create policy trends_insert_own on public.trends
  for insert to authenticated with check (user_id = auth.uid());
create policy trends_update_own on public.trends
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy trends_delete_own on public.trends
  for delete to authenticated using (user_id = auth.uid());

-- ---------- settings ----------

alter table public.settings enable row level security;

create policy settings_select_own on public.settings
  for select to authenticated using (user_id = auth.uid());
create policy settings_insert_own on public.settings
  for insert to authenticated with check (user_id = auth.uid());
create policy settings_update_own on public.settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy settings_delete_own on public.settings
  for delete to authenticated using (user_id = auth.uid());

-- ---------- usage ----------

alter table public.usage enable row level security;

create policy usage_select_own on public.usage
  for select to authenticated using (user_id = auth.uid());
create policy usage_insert_own on public.usage
  for insert to authenticated with check (user_id = auth.uid());
create policy usage_update_own on public.usage
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy usage_delete_own on public.usage
  for delete to authenticated using (user_id = auth.uid());

-- ---------- import_tokens ----------

alter table public.import_tokens enable row level security;

create policy import_tokens_select_own on public.import_tokens
  for select to authenticated using (user_id = auth.uid());
create policy import_tokens_insert_own on public.import_tokens
  for insert to authenticated with check (user_id = auth.uid());
create policy import_tokens_update_own on public.import_tokens
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy import_tokens_delete_own on public.import_tokens
  for delete to authenticated using (user_id = auth.uid());

-- ---------- privileges ----------
-- RLS only filters rows for roles that have table privileges in the first
-- place. Granting explicitly (instead of relying on project defaults) keeps
-- this schema correct wherever it is applied.

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on table
  public.ideas, public.scripts, public.results, public.trends,
  public.settings, public.usage, public.import_tokens
  to authenticated, service_role;

-- "anon" is the role a browser has before signing in. It needs no data access
-- at all: the app reads nothing until there is a session.
revoke all on table
  public.ideas, public.scripts, public.results, public.trends,
  public.settings, public.usage, public.import_tokens
  from anon;

-- Realtime: the frontend subscribes to its own ideas, scripts and results.
-- Realtime applies the same policies above, so a subscriber still only ever
-- receives their own rows.
alter publication supabase_realtime add table public.ideas;
alter publication supabase_realtime add table public.scripts;
alter publication supabase_realtime add table public.results;
