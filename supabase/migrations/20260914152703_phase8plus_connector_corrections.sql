-- =============================================================================
-- Momentum Terminal — Phase 8+: connector corrections.
--
-- 1. The publisher allowlist gains the domains the first two runs actually
--    produced. Nineteen unknown domains appeared, one item each, so no farm is
--    flooding: this is curation from observation, exactly as the floor tier was
--    meant to enable. Two are recorded AT the floor with their reasoning rather
--    than promoted.
-- 2. youtube_comments gains a metric: comment_volume, how much an audience is
--    reacting, which is a different measurement from which way it leans.
-- =============================================================================

-- Promotions, from what the runs of 2026-09-14 surfaced ------------------------
insert into public.publisher_domains (domain, status, tier, note) values
  -- Tier 2: established desks with an editorial standard.
  ('morningbrew.com',            'allowed', 2, 'Morning Brew (business newsletter with an editorial desk); observed 2026-09-14'),
  ('revolt.tv',                  'allowed', 2, 'REVOLT (hip-hop media); observed 2026-09-14'),
  -- Tier 3: metro dailies, local TV news and aggregators that report rather than rewrite.
  ('finance.yahoo.com',          'allowed', 3, 'Yahoo Finance; observed 2026-09-14'),
  ('yahoo.com',                  'allowed', 3, 'Yahoo News (largely syndicated); observed 2026-09-14'),
  ('nowtoronto.com',             'allowed', 3, 'NOW Toronto (Drake''s home city press); observed 2026-09-14'),
  ('ctinsider.com',              'allowed', 3, 'CT Insider (Hearst metro daily); observed 2026-09-14'),
  ('tennessean.com',             'allowed', 3, 'The Tennessean (Gannett metro daily); observed 2026-09-14'),
  ('fox4kc.com',                 'allowed', 3, 'FOX4 Kansas City (local TV news); observed 2026-09-14'),
  ('kctv5.com',                  'allowed', 3, 'KCTV5 Kansas City (local TV news); observed 2026-09-14'),
  ('whas11.com',                 'allowed', 3, 'WHAS11 Louisville (local TV news); observed 2026-09-14'),
  ('foxsports.com',              'allowed', 3, 'FOX Sports; observed 2026-09-14'),
  ('theankler.com',              'allowed', 3, 'The Ankler (entertainment industry newsletter); observed 2026-09-14'),
  ('entertainment.substack.com', 'allowed', 3, 'The Entertainment Strategy Guy (industry analysis newsletter); observed 2026-09-14'),
  -- Tier 4: trade and niche outlets, real but narrow.
  ('contentgrip.com',            'allowed', 4, 'ContentGrip (creator-economy trade); observed 2026-09-14'),
  ('lawcommentary.com',          'allowed', 4, 'Law Commentary (legal trade); observed 2026-09-14'),
  ('police1.com',                'allowed', 4, 'Police1 (law-enforcement trade); observed 2026-09-14'),
  ('northeasttimes.com',         'allowed', 4, 'Northeast Times (neighbourhood weekly); observed 2026-09-14'),
  -- Held AT the floor, deliberately, with the reasoning recorded. Not spam, and
  -- not a publisher either: these are the subject's own promotional channel and
  -- their partner's, speaking about the partnership. A momentum measurement
  -- must not take the subject's own marketing as evidence of momentum.
  ('amgen.com',                  'allowed', 5, 'FLOOR BY DECISION: corporate PR about a partnership with a subject, not independent coverage; the subject''s own promotional channel must not carry weight in a momentum measurement. Observed 2026-09-14.'),
  ('blog.google',                'allowed', 5, 'FLOOR BY DECISION: corporate PR about a partnership with a subject, not independent coverage; the subject''s own promotional channel must not carry weight in a momentum measurement. Observed 2026-09-14.')
on conflict (domain) do update
  set status = excluded.status,
      tier   = excluded.tier,
      note   = excluded.note,
      updated_at = now();

-- comment_volume: how MUCH the audience is reacting -----------------------------
-- The real total comment count across the newest uploads (videos.list), never
-- the capped sample the digests read: a sample could never show a surge. Window
-- and minimum sample match the other volume metrics (news_volume_24h,
-- commentary_volume_24h) so one normalisation rule covers all three.
update public.data_sources
   set config = config || '{
     "metrics": {
       "comment_volume": { "label": "YouTube comment volume", "polarity": 1, "delta": "level", "baseline_window_hours": 336, "min_samples": 24, "sd_floor": 1.0, "scale": 0.7 }
     }
   }'::jsonb
 where name = 'youtube_comments';
