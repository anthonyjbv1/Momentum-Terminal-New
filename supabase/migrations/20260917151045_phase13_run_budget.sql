-- =============================================================================
-- Momentum Terminal — Phase 13: the run that always closes.
--
-- WHAT HAPPENED. The second fifteen-minute fire (2026-09-17 15:00 UTC) hit
-- the platform's 60-second function kill. Its polls had taken 12 s; the rest
-- was the database answering in seconds rather than milliseconds for one
-- minute, and the feed-health write — ninety-four row updates in batches of
-- ten — turned that latency into forty-five seconds of waiting. The kill left
-- the run open (no finished_at, no summary) and three sources unpolled.
--
-- TWO CHANGES. The runner now carries a wall-clock budget on the scheduled
-- path (35 s) past which it records what remains as skipped and CLOSES the
-- run — the rule the Engine's tick has followed since Phase 11. And the
-- feed-health write is one round trip: this function takes the whole
-- catalogue's findings as JSON and updates only the health columns, so an
-- operator's edit to url, mode, topics or is_active is never overwritten.
-- The publisher connector's fetch budget and per-feed timeout come down to
-- 15 s and 6 s so a catalogue fetch that starts at the budget's edge still
-- ends inside the kill.
-- =============================================================================

create or replace function public.record_feed_health(rows jsonb)
returns integer
language sql
as $$
  with found as (
    select *
      from jsonb_to_recordset(rows) as r(
        id                   uuid,
        fetched_at           timestamptz,
        status               text,
        http_status          integer,
        error                text,
        item_count           integer,
        dated_count          integer,
        described_count      integer,
        matched_count        integer,
        newest_published_at  timestamptz,
        discovered_url       text,
        etag                 text,
        last_modified        text,
        consecutive_failures integer
      )
  ),
  written as (
    update public.publisher_feeds f
       set last_fetched_at          = found.fetched_at,
           last_status              = found.status,
           last_http_status         = found.http_status,
           last_error               = found.error,
           last_item_count          = found.item_count,
           last_dated_count         = found.dated_count,
           last_described_count     = found.described_count,
           last_matched_count       = found.matched_count,
           last_newest_published_at = found.newest_published_at,
           discovered_url           = found.discovered_url,
           etag                     = found.etag,
           last_modified            = found.last_modified,
           consecutive_failures     = coalesce(found.consecutive_failures, 0),
           updated_at               = found.fetched_at
      from found
     where f.id = found.id
    returning f.id
  )
  select count(*)::integer from written;
$$;

comment on function public.record_feed_health(jsonb) is
  'Phase 13. Writes what one ingestion run found for every fetched publisher feed, in one statement. Health columns only; service role only.';

revoke all on function public.record_feed_health(jsonb) from public, anon, authenticated;
grant execute on function public.record_feed_health(jsonb) to service_role;

-- The catalogue fetch inside the run budget: see the note above.
update public.data_sources
   set config = config || jsonb_build_object('fetch_budget_ms', 15000, 'feed_timeout_ms', 6000)
 where name = 'publisher_rss';
