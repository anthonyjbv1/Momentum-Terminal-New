-- =============================================================================
-- Momentum Terminal — llm_model_prices: claude-opus-5 and claude-sonnet-5
-- corrected against verified rates (confirmed 2026-09-13 against Anthropic's
-- current pricing) before the first live Engine run.
--
--   claude-opus-5     input $5.00   output $25.00   cache read $0.50
--   claude-sonnet-5   input $2.00   output $10.00   cache read $0.20
--
-- Sonnet 5 launched at $2 / $10 as introductory pricing with an increase to
-- $3 / $15 scheduled for 2026-09-01; Anthropic confirmed on 2026-09-01 that
-- $2 / $10 is the standard rate and the increase will not occur. Third-party
-- listings still showing $3 / $15 are wrong.
--
-- cache_write_per_mtok is NOT on the verified list. It is set to the standard
-- five-minute cache-write multiplier (1.25 × input) applied to the verified
-- input rate, and the note says so. The table has no batch-rate columns
-- (batch input / output at half price); adding them is a separate decision.
-- =============================================================================

update public.llm_model_prices
   set input_per_mtok       = 5.00,
       output_per_mtok      = 25.00,
       cache_read_per_mtok  = 0.50,
       cache_write_per_mtok = 6.25,
       note                 = 'Verified 2026-09-13 against Anthropic pricing: input $5, output $25, cache read $0.50. Cache write = 1.25 × input (standard 5-minute cache-write rate, not on the verified list).',
       updated_at           = now()
 where model = 'claude-opus-5';

update public.llm_model_prices
   set input_per_mtok       = 2.00,
       output_per_mtok      = 10.00,
       cache_read_per_mtok  = 0.20,
       cache_write_per_mtok = 2.50,
       note                 = 'Verified 2026-09-13 against Anthropic pricing: input $2, output $10, cache read $0.20 (the launch rate is the standard rate; the scheduled 2026-09-01 increase to $3 / $15 did not occur). Cache write = 1.25 × input (standard 5-minute cache-write rate, not on the verified list).',
       updated_at           = now()
 where model = 'claude-sonnet-5';
