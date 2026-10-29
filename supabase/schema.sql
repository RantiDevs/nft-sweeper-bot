-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again.

-- 1. The bot's data: users, wallets (already encrypted by the bot with MASTER_KEY), settings and state.
create table if not exists public.kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2. The run lock: lets exactly one copy of the bot run at a time.
create table if not exists public.locks (
  name       text primary key,
  holder     text not null,
  expires_at timestamptz not null
);

-- 3. Lock the tables away from the public API. With row-level security ON and NO policies, the public
--    "anon" / "authenticated" keys can read and write nothing. Only the server's secret key can.
alter table public.kv    enable row level security;
alter table public.locks enable row level security;
revoke all on public.kv    from anon, authenticated;
revoke all on public.locks from anon, authenticated;

-- 4. Take or renew the lock, atomically. True means the caller now holds it.
create or replace function public.acquire_lock(p_name text, p_holder text, p_ttl_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  got boolean;
begin
  insert into public.locks (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where public.locks.holder = p_holder or public.locks.expires_at < now()
  returning true into got;
  return coalesce(got, false);
end;
$$;

create or replace function public.release_lock(p_name text, p_holder text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.locks where name = p_name and holder = p_holder;
$$;

-- Only the server (service role) may call these two functions.
revoke all on function public.acquire_lock(text, text, int) from public, anon, authenticated;
revoke all on function public.release_lock(text, text)      from public, anon, authenticated;
grant execute on function public.acquire_lock(text, text, int) to service_role;
grant execute on function public.release_lock(text, text)      to service_role;
