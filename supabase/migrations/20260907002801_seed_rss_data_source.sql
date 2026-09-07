-- =============================================================================
-- Momentum Terminal — Phase 2 migration 3/3: register the RSS data source
--
-- Person-scoped RSS: each person_data_sources row for this source holds a feed
-- URL (or search term) that is about that specific person, e.g. a Google News
-- RSS query for their name. Inactive until the connector is implemented.
-- =============================================================================

insert into public.data_sources (name, display_name, tier, poll_interval_minutes, is_active)
values ('rss', 'RSS (per-person news feed)', 3, 60, false)
on conflict (name) do nothing;
