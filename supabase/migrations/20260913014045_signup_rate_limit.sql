-- =============================================================================
-- Momentum Terminal — sign-up hardening: a rate limiter, and the username
-- check closed to the public roles
--
-- * username_available() was executable by anon: anyone holding the public
--   key could walk it and enumerate registered usernames at wire speed. It
--   is now service role only; the sign-up Server Action calls it on the
--   server, behind a per-IP rate limit (lib/auth/username-availability.ts).
-- * rate_limit_buckets + rate_limit_hit(): a fixed-window counter keyed by
--   string, kept in the database so the count holds across serverless
--   instances. Service role only.
-- =============================================================================

revoke execute on function public.username_available(text) from public, anon, authenticated;
grant  execute on function public.username_available(text) to service_role;

comment on function public.username_available(text) is
  'Returns true when no user has the given username (case-insensitive). SERVICE ROLE ONLY since the sign-up hardening: the sign-up action calls it on the server behind a per-IP rate limit, so it cannot be walked to enumerate usernames.';

-- rate_limit_buckets -------------------------------------------------------------
create table public.rate_limit_buckets (
  key               text        primary key,
  window_started_at timestamptz not null,
  hits              integer     not null default 0,

  constraint rate_limit_buckets_hits_nonneg check (hits >= 0)
);

create index rate_limit_buckets_window_idx on public.rate_limit_buckets (window_started_at);

comment on table public.rate_limit_buckets is 'Fixed-window counters for the public entry points that can be walked (the sign-up username check). Service role only; read and written by rate_limit_hit().';

alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from anon, authenticated;

-- rate_limit_hit -----------------------------------------------------------------
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now     timestamptz := now();
  v_window  interval    := make_interval(secs => p_window_seconds);
  v_hits    integer;
  v_started timestamptz;
begin
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'rate_limit_hit: key is required' using errcode = 'check_violation';
  end if;
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'rate_limit_hit: limit and window must be positive' using errcode = 'check_violation';
  end if;

  insert into public.rate_limit_buckets as b (key, window_started_at, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set hits              = case when b.window_started_at + v_window <= v_now then 1 else b.hits + 1 end,
        window_started_at = case when b.window_started_at + v_window <= v_now then v_now else b.window_started_at end
  returning hits, window_started_at into v_hits, v_started;

  -- Housekeeping: buckets whose window ended a day ago are of no further use.
  delete from public.rate_limit_buckets
   where window_started_at < v_now - interval '1 day'
     and key <> p_key;

  return jsonb_build_object(
    'allowed',             v_hits <= p_limit,
    'hits',                v_hits,
    'limit',               p_limit,
    'remaining',           greatest(0, p_limit - v_hits),
    'window_started_at',   v_started,
    'retry_after_seconds', case when v_hits <= p_limit then 0 else ceil(extract(epoch from (v_started + v_window - v_now)))::integer end
  );
end;
$$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant  execute on function public.rate_limit_hit(text, integer, integer) to service_role;

comment on function public.rate_limit_hit(text, integer, integer) is
  'Counts one hit against a fixed window for a key and says whether it is allowed, how many remain, and when to retry. Service role only.';
