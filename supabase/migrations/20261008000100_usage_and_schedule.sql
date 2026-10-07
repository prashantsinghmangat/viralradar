-- Counting API usage, and refreshing the radar every morning by itself.
--
-- Two separate things that happen to arrive together:
--   1. add_usage(), so the YouTube quota can be counted without a read-then-
--      write race between two refreshes running at once.
--   2. the daily schedule: pg_cron asks pg_net to call vr-refresh-trends at
--      01:30 UTC, which is 07:00 in India.

-- ---------- counting usage ----------
--
-- A plain "read the row, add to it, write it back" can lose a count when two
-- calls overlap. One statement with ON CONFLICT cannot.
--
-- SECURITY INVOKER on purpose: run as whoever called it, so Row Level Security
-- still applies. Passing someone else's user_id is refused by the policy rather
-- than quietly accepted, which is exactly what should happen.

create or replace function viralradar.add_usage(
  p_user_id uuid,
  p_provider text,
  p_units integer,
  p_requests integer
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into viralradar.usage (user_id, date, provider, units, requests)
  values (p_user_id, viralradar.ist_today(), p_provider, coalesce(p_units, 0), coalesce(p_requests, 0))
  on conflict (user_id, date, provider) do update
    set units    = viralradar.usage.units + excluded.units,
        requests = viralradar.usage.requests + excluded.requests,
        updated_at = now();
$$;

comment on function viralradar.add_usage is
  'Add to today''s usage for one provider, in one statement so overlapping calls cannot lose a count.';

revoke all on function viralradar.add_usage(uuid, text, integer, integer) from public;
grant execute on function viralradar.add_usage(uuid, text, integer, integer) to authenticated, service_role;

-- ---------- the daily schedule ----------

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Where to call, and for whom. One row, filled in by hand after signing up.
-- RLS is on with no policies, and nothing is granted to anon or authenticated,
-- so only the service role and the database owner can read it: the function URL
-- and the user id are not things a signed-in browser needs.
create table viralradar.cron_config (
  id           boolean primary key default true check (id),
  function_url text not null,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table viralradar.cron_config is
  'One row: which function the morning refresh calls, and whose radar it fills. The secret is not here; it is in Vault.';

alter table viralradar.cron_config enable row level security;
revoke all on table viralradar.cron_config from anon, authenticated;
grant select, insert, update, delete on table viralradar.cron_config to service_role;

create trigger cron_config_touch_updated_at before update on viralradar.cron_config
  for each row execute function viralradar.touch_updated_at();

-- What the schedule actually runs.
--
-- The secret lives in Supabase Vault, not in this function and not in the
-- config table, so reading the table tells you nothing that would let you
-- trigger a refresh. SECURITY DEFINER because the job runs as the postgres
-- role and still needs to read an encrypted secret.
--
-- If cron_config is empty this does nothing at all, which is the right
-- behaviour before anyone has set it up.
create or replace function viralradar.request_trend_refresh()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg    viralradar.cron_config;
  secret text;
begin
  select * into cfg from viralradar.cron_config limit 1;
  if not found then
    raise notice 'viralradar: no cron_config row, nothing to refresh';
    return;
  end if;

  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'viralradar_cron_secret'
  limit 1;

  if secret is null then
    raise warning 'viralradar: no viralradar_cron_secret in Vault, not calling the function';
    return;
  end if;

  perform net.http_post(
    url     := cfg.function_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-vr-cron-secret', secret
               ),
    body    := jsonb_build_object('user_id', cfg.user_id),
    timeout_milliseconds := 120000   -- four sources, one of which rate limits
  );
end;
$$;

comment on function viralradar.request_trend_refresh is
  'Called by the schedule. Reads where to call from cron_config and the secret from Vault, then asks vr-refresh-trends to collect today''s trends.';

revoke all on function viralradar.request_trend_refresh() from public, anon, authenticated;

-- 01:30 UTC is 07:00 IST. pg_cron schedules by name, so applying this twice
-- updates the job rather than creating a second one.
--
-- This project is shared with another app that already has a job of its own,
-- hence the prefix: nothing here touches it.
select cron.schedule(
  'viralradar-refresh-trends',
  '30 1 * * *',
  $$ select viralradar.request_trend_refresh(); $$
);
