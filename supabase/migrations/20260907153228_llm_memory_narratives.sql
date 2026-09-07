-- =============================================================================
-- Momentum Terminal — Phase 4 migration: LLM reasoning layer + memory
--
-- * person_memory  per-person profile, baseline patterns and a rolling summary
--                  of recent notable events. The LLM scorer reads it so that
--                  "routine vs anomalous" is judged relative to THIS person.
-- * llm_usage      one row per LLM call (provider, model, task, tokens) so cost
--                  is observable. Service role only.
-- * narratives     the Engine's short, human-readable explanation of a
--                  meaningful score move, keyed by person and tick.
-- =============================================================================

-- person_memory ---------------------------------------------------------------
create table public.person_memory (
  id                uuid        primary key default gen_random_uuid(),
  person_id         uuid        not null unique references public.people (id) on delete cascade,
  profile           jsonb       not null default '{}'::jsonb,
  baseline_patterns jsonb       not null default '{}'::jsonb,
  recent_context    jsonb       not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);

comment on table  public.person_memory is 'What the Engine knows about each person: who they are, what is routine vs notable for them, and a rolling summary of recent events.';
comment on column public.person_memory.profile           is 'Who they are, what they do, what drives their momentum. Seeded; slow-changing.';
comment on column public.person_memory.baseline_patterns is 'Normal ranges: typical signal volume, typical magnitude of changes, what is routine vs notable for this person.';
comment on column public.person_memory.recent_context    is 'Rolling summary of recent notable events, updated by the Engine after ticks. Summarised, never a raw log.';

alter table public.person_memory enable row level security;

create policy person_memory_select_authenticated
  on public.person_memory for select
  to authenticated
  using (true);

revoke insert, update, delete on public.person_memory from anon, authenticated;

-- llm_usage -------------------------------------------------------------------
create table public.llm_usage (
  id                          uuid        primary key default gen_random_uuid(),
  provider                    text        not null,
  model                       text        not null,
  task_type                   text        not null,
  input_tokens                integer     not null default 0,
  output_tokens               integer     not null default 0,
  cache_read_input_tokens     integer     not null default 0,
  cache_creation_input_tokens integer     not null default 0,
  latency_ms                  integer,
  person_id                   uuid        references public.people (id) on delete set null,
  tick_number                 bigint,
  created_at                  timestamptz not null default now(),

  constraint llm_usage_task_type_check check (task_type in ('sentiment', 'anomaly', 'narrative', 'memory')),
  constraint llm_usage_tokens_nonneg   check (input_tokens >= 0 and output_tokens >= 0)
);

create index llm_usage_created_idx   on public.llm_usage (created_at desc);
create index llm_usage_person_id_idx on public.llm_usage (person_id);

comment on table public.llm_usage is 'Token usage per LLM call. Cost = tokens x the model price list. Service role only.';

-- No client policies: the usage ledger is internal.
alter table public.llm_usage enable row level security;
revoke all on public.llm_usage from anon, authenticated;

-- narratives ------------------------------------------------------------------
create table public.narratives (
  id           uuid        primary key default gen_random_uuid(),
  person_id    uuid        not null references public.people (id) on delete cascade,
  tick_number  bigint      not null references public.engine_ticks (tick_number) on delete cascade,
  text         text        not null,
  score_before numeric     not null,
  score_after  numeric     not null,
  source       text        not null default 'template',
  created_at   timestamptz not null default now(),

  constraint narratives_source_check   check (source in ('llm', 'template')),
  constraint narratives_text_nonempty  check (length(trim(text)) > 0)
);

create index narratives_person_tick_idx on public.narratives (person_id, tick_number desc);
create index narratives_tick_number_idx on public.narratives (tick_number desc);

comment on table  public.narratives is 'The Engine explaining, in one or two sentences, why a person''s score moved meaningfully this tick.';
comment on column public.narratives.source is 'llm = reused from the LLM signal reasoning; template = deterministic wording from the force breakdown.';

alter table public.narratives enable row level security;

create policy narratives_select_authenticated
  on public.narratives for select
  to authenticated
  using (true);

revoke insert, update, delete on public.narratives from anon, authenticated;

-- seed: concise factual baselines for the 16 people --------------------------
insert into public.person_memory (person_id, profile, baseline_patterns, recent_context)
select p.id, s.profile, s.baseline_patterns, '{"summary": "No notable events recorded yet.", "notable_events": []}'::jsonb
  from (values
    ('elon-musk',
     '{"role": "executive", "summary": "CEO of Tesla and SpaceX; leads xAI and owns X.", "momentum_drivers": ["Tesla stock and deliveries", "SpaceX and Starship launches", "xAI and X developments", "public statements and controversies", "net worth swings"], "context": "One of the most-covered people in the world with a constant headline flow."}'::jsonb,
     '{"typical_signal_volume": "very high", "typical_change_magnitude": "large", "routine": ["daily Tesla stock moves", "social media posts", "minor product or personnel headlines", "net worth changes under about 5%"], "notable": ["earnings and delivery reports", "Starship launches or failures", "regulatory or legal actions", "major product launches"], "noise_note": "A 2% net worth move is noise for Musk."}'::jsonb),
    ('mrbeast',
     '{"role": "creator", "summary": "The most-subscribed individual creator on YouTube; founder of Feastables and Beast Philanthropy.", "momentum_drivers": ["subscriber growth", "viral videos and view counts", "business ventures and brand deals", "philanthropy stunts", "controversies"], "context": "Momentum is driven by audience scale and business expansion."}'::jsonb,
     '{"typical_signal_volume": "high", "typical_change_magnitude": "moderate", "routine": ["steady daily subscriber gains", "regular uploads", "incremental subscriber milestones"], "notable": ["record-breaking videos", "major business or partnership news", "controversies or lawsuits", "large round-number milestones"], "noise_note": "Crossing a 1M-subscriber step is routine at his scale; a 10M step is notable."}'::jsonb),
    ('kai-cenat',
     '{"role": "creator", "summary": "Twitch streamer and content creator; co-founder of AMP.", "momentum_drivers": ["subathons and Twitch subscriber records", "collaborations with celebrities", "viral moments", "brand deals", "controversies"], "context": "Momentum spikes around events and collaborations rather than steady growth."}'::jsonb,
     '{"typical_signal_volume": "high", "typical_change_magnitude": "moderate", "routine": ["daily streams", "normal viewer counts", "small follower gains"], "notable": ["subscriber records", "major collaborations", "platform bans or controversies", "awards"], "noise_note": "Daily stream metrics are noise; records and events are signal."}'::jsonb),
    ('drake',
     '{"role": "musician", "summary": "Rapper and singer; founder of OVO Sound; among the most-streamed artists ever.", "momentum_drivers": ["album and single releases", "chart positions", "streaming numbers", "tours", "feuds and cultural moments", "legal actions"], "context": "Releases and cultural moments dominate; streaming volume is always high."}'::jsonb,
     '{"typical_signal_volume": "high", "typical_change_magnitude": "moderate", "routine": ["weekly streaming statistics", "minor chart movement", "social media activity"], "notable": ["album or single drops", "number-one debuts", "feud escalations", "lawsuits", "tour announcements"], "noise_note": "Small weekly streaming changes are noise; a release or a number-one is signal."}'::jsonb),
    ('adin-ross',
     '{"role": "creator", "summary": "Live streamer and content creator known for celebrity collaborations.", "momentum_drivers": ["stream viewership", "celebrity collaborations", "platform deals", "controversies and bans"], "context": "Momentum is volatile and driven by controversy and high-profile guests."}'::jsonb,
     '{"typical_signal_volume": "high", "typical_change_magnitude": "large", "routine": ["daily streams", "ordinary viewer numbers", "minor online drama"], "notable": ["bans or suspensions", "major celebrity collaborations", "platform contract news", "serious controversies"], "noise_note": "Minor drama is routine for Ross; only bans, contracts and major guests are notable."}'::jsonb),
    ('patrick-mahomes',
     '{"role": "athlete", "summary": "Quarterback for the Kansas City Chiefs; multiple Super Bowl wins and MVP awards.", "momentum_drivers": ["game performances and results", "playoff runs", "injuries", "awards and records", "endorsements"], "context": "Weekly cadence during the NFL season, quiet in the off-season."}'::jsonb,
     '{"typical_signal_volume": "medium", "typical_change_magnitude": "moderate", "routine": ["regular-season statistics", "practice and press-conference notes", "routine wins"], "notable": ["playoff results", "injuries", "MVP or record milestones", "Super Bowl appearances"], "noise_note": "Regular-season stat lines are routine; injuries and playoff outcomes are signal."}'::jsonb),
    ('kendrick-lamar',
     '{"role": "musician", "summary": "Rapper and songwriter; Pulitzer Prize winner; co-founder of pgLang.", "momentum_drivers": ["album and single releases", "awards", "chart and streaming performance", "major performances", "feuds"], "context": "Releases are rare and heavily anticipated; awards and performances carry weight."}'::jsonb,
     '{"typical_signal_volume": "medium", "typical_change_magnitude": "moderate", "routine": ["weekly streaming statistics", "minor chart movement"], "notable": ["releases", "Grammy or major awards", "headline performances", "feud developments"], "noise_note": "Streaming drift is noise; a release or award is signal."}'::jsonb),
    ('jensen-huang',
     '{"role": "executive", "summary": "Co-founder and CEO of NVIDIA.", "momentum_drivers": ["NVIDIA stock and earnings", "AI chip launches and keynotes", "export policy and regulation", "major customer deals"], "context": "Tightly coupled to the AI hardware cycle and NVIDIA market value."}'::jsonb,
     '{"typical_signal_volume": "high", "typical_change_magnitude": "moderate", "routine": ["daily NVIDIA stock moves", "conference appearances", "minor partnership notes"], "notable": ["earnings reports", "GTC product launches", "export restrictions", "very large customer deals"], "noise_note": "Daily stock moves under a few percent are routine; earnings and policy shocks are notable."}'::jsonb),
    ('mark-zuckerberg',
     '{"role": "executive", "summary": "Co-founder and CEO of Meta Platforms.", "momentum_drivers": ["Meta stock and earnings", "AI and product launches", "regulatory and legal outcomes", "public appearances"], "context": "Momentum tracks Meta results and the reception of major product bets."}'::jsonb,
     '{"typical_signal_volume": "high", "typical_change_magnitude": "moderate", "routine": ["daily Meta stock moves", "feature updates", "interviews"], "notable": ["earnings reports", "major AI or hardware launches", "antitrust or privacy rulings", "large strategic shifts"], "noise_note": "Routine feature news is noise; earnings and rulings are signal."}'::jsonb),
    ('warren-buffett',
     '{"role": "executive", "summary": "Chairman of Berkshire Hathaway; long-time value investor.", "momentum_drivers": ["Berkshire results and portfolio moves", "annual letters and meetings", "succession news", "health"], "context": "Low-frequency, high-weight signals; rarely in the daily news cycle."}'::jsonb,
     '{"typical_signal_volume": "low", "typical_change_magnitude": "small", "routine": ["small net worth drift with Berkshire stock", "occasional interviews"], "notable": ["large portfolio changes", "annual meeting statements", "succession or health news", "any net worth move above about 2%"], "noise_note": "A 2% net worth move is notable for Buffett, unlike for Musk."}'::jsonb),
    ('larry-ellison',
     '{"role": "executive", "summary": "Co-founder and chairman of Oracle.", "momentum_drivers": ["Oracle stock and cloud or AI deals", "net worth swings tied to Oracle", "acquisitions and media ventures", "personal ventures"], "context": "Net worth is highly sensitive to Oracle stock."}'::jsonb,
     '{"typical_signal_volume": "medium", "typical_change_magnitude": "moderate", "routine": ["daily Oracle stock moves", "minor deal announcements"], "notable": ["very large cloud or AI contracts", "double-digit net worth moves", "major acquisitions"], "noise_note": "Ordinary stock drift is routine; a major contract or a double-digit swing is signal."}'::jsonb),
    ('jeff-bezos',
     '{"role": "executive", "summary": "Founder and executive chairman of Amazon; founder of Blue Origin.", "momentum_drivers": ["Amazon stock", "Blue Origin launches", "large stock sales", "philanthropy and personal news"], "context": "Momentum comes from Amazon market value and Blue Origin milestones."}'::jsonb,
     '{"typical_signal_volume": "medium", "typical_change_magnitude": "moderate", "routine": ["daily Amazon stock moves", "routine Blue Origin updates"], "notable": ["major launches or failures", "large share sales", "major announcements"], "noise_note": "Small stock moves are noise; launches and large sales are signal."}'::jsonb),
    ('larry-page',
     '{"role": "executive", "summary": "Co-founder of Google; largely out of public view.", "momentum_drivers": ["Alphabet stock and net worth", "rare public appearances or ventures"], "context": "Very few direct signals; mostly net-worth driven."}'::jsonb,
     '{"typical_signal_volume": "very low", "typical_change_magnitude": "small", "routine": ["net worth drift with Alphabet stock"], "notable": ["any public appearance or statement", "new venture news"], "noise_note": "Almost anything beyond stock drift is notable because signals are so rare."}'::jsonb),
    ('sergey-brin',
     '{"role": "executive", "summary": "Co-founder of Google; more recently involved again in Google AI work.", "momentum_drivers": ["Alphabet stock and net worth", "public statements", "involvement in Google AI"], "context": "Low signal volume with occasional high-interest statements."}'::jsonb,
     '{"typical_signal_volume": "low", "typical_change_magnitude": "small", "routine": ["net worth drift with Alphabet stock"], "notable": ["public statements", "news about his AI involvement", "personal news"], "noise_note": "Stock drift is noise; public statements are signal."}'::jsonb),
    ('michael-dell',
     '{"role": "executive", "summary": "Founder, chairman and CEO of Dell Technologies.", "momentum_drivers": ["Dell stock and earnings", "AI server demand", "net worth"], "context": "Momentum tracks Dell results and AI infrastructure demand."}'::jsonb,
     '{"typical_signal_volume": "medium", "typical_change_magnitude": "moderate", "routine": ["daily Dell stock moves", "product announcements"], "notable": ["earnings reports", "large AI infrastructure deals", "major net worth moves"], "noise_note": "Product notes are routine; earnings and big deals are signal."}'::jsonb),
    ('anthony-baptiste',
     '{"role": "founder", "summary": "Founder of Momentum Terminal.", "momentum_drivers": ["product launches", "platform milestones", "partnerships", "press coverage"], "context": "Early-stage founder; external signal volume is low at launch and driven by platform milestones."}'::jsonb,
     '{"typical_signal_volume": "low", "typical_change_magnitude": "small", "routine": ["minor product updates", "social posts"], "notable": ["launches", "funding or partnerships", "press coverage", "user or volume milestones"], "noise_note": "Because signals are rare, most concrete milestones are notable."}'::jsonb)
  ) as s(slug, profile, baseline_patterns)
  join public.people p on p.slug = s.slug
on conflict (person_id) do nothing;
