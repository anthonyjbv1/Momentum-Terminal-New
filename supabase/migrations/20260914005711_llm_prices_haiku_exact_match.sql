-- =============================================================================
-- Momentum Terminal — llm_model_prices: a row for Haiku 4.5 under the exact
-- string the API echoes, and exact (not prefix) model matching in
-- llm_cost_per_tick. Applied before the bounded Engine run; the cron stays off.
--
-- 1. Haiku 4.5. Sentiment scoring, the highest-volume task, is routed to it
--    (LLM_MODEL_SENTIMENT). Verified 2026-09-14 against Anthropic pricing:
--      input $1.00   output $5.00   cache read $0.10
--    cache_write_per_mtok is the standard five-minute multiplier (1.25 × input),
--    not on the verified list, noted the same way as the other rows.
--
--    The string. The Anthropic adapter records message.model from the API
--    RESPONSE, not the string it requested. Haiku 4.5's model ID carries a
--    date suffix (claude-haiku-4-5-20251001) and its alias (claude-haiku-4-5)
--    resolves to it, so a usage row carries the dated ID whichever the operator
--    configured. The new row is keyed by the dated ID. The alias row stays with
--    the same rates (its note corrected) so a configured alias also reads as
--    priced; it is never what a usage row carries. Opus 5 and Sonnet 5 have
--    undated IDs, so their rows already equal what the API echoes.
--
-- 2. Exact matching. The view matched a usage row to the longest price row that
--    was a prefix of its model, so a future claude-opus-5-1 would have been
--    priced as claude-opus-5 without anyone noticing. It now joins on equality:
--    an unknown string counts in unpriced_calls instead of being mispriced.
--    No suffix normalisation anywhere: the Haiku case is handled by pricing the
--    exact string.
-- =============================================================================

insert into public.llm_model_prices (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, note)
values (
  'claude-haiku-4-5-20251001', 1.00, 5.00, 0.10, 1.25,
  'Verified 2026-09-14 against Anthropic pricing: input $1, output $5, cache read $0.10. Cache write = 1.25 × input (standard 5-minute cache-write rate, not on the verified list). The dated ID is what the Messages API echoes for Haiku 4.5, alias or dated request alike, and so what llm_usage carries.'
)
on conflict (model) do update
   set input_per_mtok       = excluded.input_per_mtok,
       output_per_mtok      = excluded.output_per_mtok,
       cache_read_per_mtok  = excluded.cache_read_per_mtok,
       cache_write_per_mtok = excluded.cache_write_per_mtok,
       note                 = excluded.note,
       updated_at           = now();

update public.llm_model_prices
   set input_per_mtok       = 1.00,
       output_per_mtok      = 5.00,
       cache_read_per_mtok  = 0.10,
       cache_write_per_mtok = 1.25,
       note                 = 'Verified 2026-09-14 against Anthropic pricing: input $1, output $5, cache read $0.10. Cache write = 1.25 × input (standard 5-minute cache-write rate, not on the verified list). Alias of claude-haiku-4-5-20251001: the API echoes the dated ID, so usage rows never carry this string; kept so a configured alias reads as priced.',
       updated_at           = now()
 where model = 'claude-haiku-4-5';

comment on table public.llm_model_prices is 'USD per million tokens by model, for llm_cost_per_tick. A usage row matches the price row whose model equals its own exactly (the string the provider echoes, e.g. claude-haiku-4-5-20251001); any other string counts as unpriced. Service role only.';

create or replace view public.llm_cost_per_tick with (security_invoker = true) as
select u.tick_number,
       count(*)                                                       as calls,
       count(*) filter (where u.task_type = 'sentiment')              as sentiment_calls,
       count(*) filter (where u.task_type = 'anomaly')                as anomaly_calls,
       count(*) filter (where u.task_type = 'narrative')              as narrative_calls,
       count(*) filter (where u.task_type = 'memory')                 as memory_calls,
       sum(u.input_tokens)                                            as input_tokens,
       sum(u.output_tokens)                                           as output_tokens,
       sum(u.cache_read_input_tokens)                                 as cache_read_input_tokens,
       sum(u.cache_creation_input_tokens)                             as cache_creation_input_tokens,
       round(sum(
         (u.input_tokens * p.input_per_mtok
          + u.output_tokens * p.output_per_mtok
          + u.cache_read_input_tokens * p.cache_read_per_mtok
          + u.cache_creation_input_tokens * p.cache_write_per_mtok) / 1000000.0
       ), 6)                                                          as cost_usd,
       count(*) filter (where p.model is null)                        as unpriced_calls,
       round(avg(u.latency_ms))                                       as avg_latency_ms,
       min(u.created_at)                                              as first_call_at,
       max(u.created_at)                                              as last_call_at
  from public.llm_usage u
  left join public.llm_model_prices p on p.model = u.model
 group by u.tick_number;

comment on view public.llm_cost_per_tick is 'LLM calls, tokens and priced cost per Engine tick (tick_number null = outside a tick). A call is priced only when its model string equals a price row exactly; cost_usd covers priced calls, unpriced_calls says how many matched nothing. Service role only.';

revoke all on public.llm_cost_per_tick from anon, authenticated;
