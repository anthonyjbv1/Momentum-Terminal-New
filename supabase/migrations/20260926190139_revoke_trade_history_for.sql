-- trade_history_for() back to the service role only.
--
-- trade_history_for(p_user_id, ...) reads any member's trade history by id. It
-- is SECURITY DEFINER with no caller check, by design: it is the server's read,
-- and my_trade_history() is the signed-in member's way in, passing auth.uid().
--
-- Phase 27 (20260922211703) dropped and re-created it and then revoked only
-- from PUBLIC. Supabase's default privileges grant EXECUTE on every new
-- function in public to anon and authenticated by name, not through PUBLIC, so
-- both roles kept it: anyone holding the public key and a member's id could
-- read that member's trades. Phase 29's create or replace kept the grants.
--
-- my_trade_history() keeps working: it is SECURITY DEFINER owned by postgres,
-- so its call to trade_history_for() runs as the owner, which keeps EXECUTE.
-- The app reads trade history only through my_trade_history().

revoke execute on function public.trade_history_for(uuid, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.trade_history_for(uuid, timestamptz, uuid, integer) to service_role;
