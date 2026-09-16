-- =============================================================================
-- PHASE 11: THE USAGE LEDGER IN TWO HALVES
--
-- llm_usage was written only after a call returned. Exact in steady state,
-- blind in the one situation it most needed to report: when the function was
-- killed with calls in flight, Anthropic billed them and nothing recorded
-- them. The first cron run cost ~$0.42–0.65 against a ledger reading $0.16.
--
-- A call is now written BEFORE it is made (status 'started', no tokens) and
-- updated when it returns ('completed', with usage) or throws ('failed', with
-- the reason). A row still 'started' is a call the process died inside —
-- billed, invisible before, visible now. A 'failed' row is a timeout or
-- provider error, which also left no trace before.
--
-- llm_cost_per_tick keeps every existing column (name, type, order) and gains
-- three at the end: completed_calls, failed_calls, started_calls. `calls`
-- now counts attempts; unpriced_calls counts only completed rows, because an
-- unsettled row carries the requested model, not the echoed one.
-- =============================================================================

alter table public.llm_usage
  add column status     text        not null default 'completed',
  add column error      text,
  add column started_at timestamptz;

alter table public.llm_usage
  add constraint llm_usage_status_check check (status in ('started', 'completed', 'failed'));

-- Unsettled rows are the ones an operator looks for; they should stay rare.
create index llm_usage_unsettled_idx on public.llm_usage (status, created_at desc) where status <> 'completed';

comment on column public.llm_usage.status     is 'started = written before the call, not yet settled (a row that stays here is a call the process died inside); completed = returned, tokens recorded; failed = threw (timeout, provider error), see error.';
comment on column public.llm_usage.error      is 'Why a failed call failed, from the adapter''s error kind and message.';
comment on column public.llm_usage.started_at is 'When the call was started; created_at is when the row was written, which for a two-phase row is the same instant.';
comment on table  public.llm_usage is 'Every LLM call, written before it is made and settled when it returns. Cost = tokens x the model price list, completed rows only. Service role only.';

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
       count(*) filter (where p.model is null and u.status = 'completed') as unpriced_calls,
       round(avg(u.latency_ms))                                       as avg_latency_ms,
       min(u.created_at)                                              as first_call_at,
       max(u.created_at)                                              as last_call_at,
       count(*) filter (where u.status = 'completed')                 as completed_calls,
       count(*) filter (where u.status = 'failed')                    as failed_calls,
       count(*) filter (where u.status = 'started')                   as started_calls
  from public.llm_usage u
  left join public.llm_model_prices p on p.model = u.model
 group by u.tick_number;

comment on view public.llm_cost_per_tick is 'LLM calls, tokens and priced cost per Engine tick (tick_number null = outside a tick). calls counts attempts; completed_calls / failed_calls / started_calls split them, and a started_calls above zero on a finished tick means the process died with that call in flight. A call is priced only when its model string equals a price row exactly; cost_usd covers priced completed calls, unpriced_calls says how many completed calls matched nothing. Service role only.';

revoke all on public.llm_cost_per_tick from anon, authenticated;
