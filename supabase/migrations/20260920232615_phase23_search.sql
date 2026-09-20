-- =============================================================================
-- Momentum Terminal — Phase 23: SEARCH — who may be found, and how.
--
-- Two things live here. A consent flag that decides whether a person is
-- findable at all, and the query that finds them.
--
-- THE FLAG IS OFF BY DEFAULT, and that is the whole point of it. Every
-- privacy gate in this codebase ships off and must be opted into —
-- publish_observed, forecast_paused, shorting_enabled, the drift flag — and
-- being listed as a tradeable index under your own name is a heavier thing to
-- be opted into than any of them. forecast_paused (Phase 19) is the precedent
-- for a per-person switch of exactly this shape: a boolean on people, set by
-- SQL because the admin console is read-only by design, read server-side.
-- This is its inverse in polarity and its twin in mechanism.
--
-- The sixteen current subjects are public figures whose momentum is already
-- the public board, so they are turned ON here, by name, one slug at a time.
-- Not `where is_active`, and not a special case for "public figures" in
-- application code: an explicit list is a record of a decision, and the next
-- person added to the roster starts off until somebody writes their slug down
-- the same way.
--
-- ENFORCEMENT IS SERVER-SIDE AND SINGULAR. The flag is tested inside
-- search_people() itself, not in the UI and not in the caller, so a person
-- who has not opted in is not reachable through the search RPC at all — not
-- by a different caller, not by the service role, not by asking for a larger
-- limit. There is one predicate and it is in the database.
--
-- WHERE A CONNECTIONS TIER WOULD GO, since it is out of scope today but must
-- not require reshaping this. is_discoverable stays the outer gate: off means
-- unreachable, full stop. The tier arrives later as a second column that can
-- only NARROW within it —
--
--     alter table public.people add column discoverable_to text not null
--       default 'everyone' check (discoverable_to in ('everyone', 'connections'));
--
-- — and one more conjunct in the single gate block below:
--
--     and p.is_discoverable
--     and (p.discoverable_to = 'everyone'
--          or exists (select 1 from public.connections c
--                      where c.person_id = p.id and c.user_id = (select auth.uid())))
--
-- Nothing else moves: no existing row changes meaning, the partial indexes
-- below stay valid because their predicate is the boolean, the returned
-- columns are unchanged, and no call site is touched. This is also why
-- search_people() is SECURITY INVOKER rather than DEFINER — it runs as the
-- caller, so auth.uid() is the connected user's, which is exactly what a
-- connections check needs and what a definer function would have thrown away.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The flag
-- -----------------------------------------------------------------------------

alter table public.people
  add column is_discoverable boolean not null default false;

comment on column public.people.is_discoverable is
  'Phase 23: when true, this person can be found through search_people(). DEFAULT FALSE — being findable is opted into, never inherited. Admin-set by SQL, like forecast_paused. Enforced inside the search RPC, so a false here is unreachability rather than a hidden row in the UI.';

-- The sixteen, by name. Each of these is a public figure already ranked on the
-- public board, which is the reason and the only reason the flag is on.
update public.people
   set is_discoverable = true
 where slug in (
   'adin-ross',
   'anthony-baptiste',
   'drake',
   'elon-musk',
   'jeff-bezos',
   'jensen-huang',
   'kai-cenat',
   'kendrick-lamar',
   'larry-ellison',
   'larry-page',
   'mark-zuckerberg',
   'michael-dell',
   'mrbeast',
   'patrick-mahomes',
   'sergey-brin',
   'warren-buffett'
 );

-- -----------------------------------------------------------------------------
-- 2. Normalisation: what "forgiving of case and punctuation" actually means
-- -----------------------------------------------------------------------------
--
-- Two forms of the same string, both IMMUTABLE so they can be indexed.
--
--   search_terms('Jen-Hsun Huang')  ->  'jen hsun huang'   (words, separated)
--   search_key('Jen-Hsun Huang')    ->  'jenhsunhuang'     (words, run together)
--
-- The terms form keeps word boundaries so "huang" can be recognised as the
-- start of a word rather than a fragment in the middle of one. The key form
-- throws the boundaries away so that a query typed with different punctuation
-- than the name carries — "kai-cenat", "MrBeast", "mr beast", "jenhsun" —
-- still lands on the same string. Both lowercase, and both fold the Latin
-- diacritics to their bare letters, so "Beyoncé" is reachable as "beyonce"
-- the day someone by that name is on the roster.
--
-- Folding is done with translate() over an explicit pair list rather than
-- unaccent(): unaccent is an extension, it is not immutable (its dictionary
-- is a mutable catalogue), so it cannot appear in an index expression — and
-- the test harness runs these migrations on a stock Postgres with no
-- extensions installed. The two arguments are built with repeat() precisely
-- so that their lengths are correct by construction rather than by counting.

create or replace function public.search_terms(p_text text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select trim(both ' ' from regexp_replace(
    translate(
      -- The one-to-many folds, which translate() cannot express.
      replace(replace(replace(replace(lower(p_text), 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'), 'ø', 'o'),
      'àáâãäåāăą' || 'çćĉċč' || 'ďđ' || 'èéêëēĕėęě' || 'ĝğġģ' || 'ĥħ' || 'ìíîïĩīĭįı' || 'ĵ' || 'ķ'
        || 'ĺļľł' || 'ñńņň' || 'òóôõöōŏő' || 'ŕŗř' || 'śŝşš' || 'ţťŧ' || 'ùúûüũūŭůűų' || 'ŵ' || 'ýÿŷ' || 'źżž',
      repeat('a', 9) || repeat('c', 5) || repeat('d', 2) || repeat('e', 9) || repeat('g', 4) || repeat('h', 2)
        || repeat('i', 9) || 'j' || 'k' || repeat('l', 4) || repeat('n', 4) || repeat('o', 8) || repeat('r', 3)
        || repeat('s', 4) || repeat('t', 3) || repeat('u', 10) || 'w' || repeat('y', 3) || repeat('z', 3)
    ),
    -- Everything that is not a letter or a digit is a separator: spaces,
    -- hyphens, apostrophes, periods, the @ on a handle, emoji, all of it.
    '[^a-z0-9]+', ' ', 'g'))
$$;

comment on function public.search_terms(text) is
  'Phase 23: a string reduced to lowercase space-separated words, Latin diacritics folded. Immutable, so it can be indexed. Keeps word boundaries; see search_key() for the form that drops them.';

create or replace function public.search_key(p_text text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select replace(public.search_terms(p_text), ' ', '')
$$;

comment on function public.search_key(text) is
  'Phase 23: search_terms() with the separators removed — "Kai Cenat", "kai-cenat" and "KaiCenat" all become "kaicenat". Contains only [a-z0-9], which is what makes it safe to interpolate into a LIKE pattern.';

-- -----------------------------------------------------------------------------
-- 3. Indexes
-- -----------------------------------------------------------------------------
--
-- Partial on the gate, so the index IS the discoverable set and a person who
-- has not opted in is not in it. text_pattern_ops because the ordering these
-- serve is LIKE 'needle%', not the collation's.
--
-- These cover the anchored half of the query — an exact key and a prefix of
-- the key. The contains half ("beast" inside "mrbeast") cannot ride a b-tree
-- and scans the discoverable set; see the scale note at the foot of this file.

create index people_search_name_idx on public.people (public.search_key(display_name) text_pattern_ops)
  where is_active and is_discoverable;
create index people_search_full_idx on public.people (public.search_key(full_name) text_pattern_ops)
  where is_active and is_discoverable;
create index people_search_slug_idx on public.people (public.search_key(slug) text_pattern_ops)
  where is_active and is_discoverable;

-- -----------------------------------------------------------------------------
-- 4. search_people()
-- -----------------------------------------------------------------------------
--
-- Name, full name or slug; partial; case- and punctuation-forgiving. Returns
-- what a result row shows and nothing else: who they are, what they do, where
-- their score stands and which way it is moving.
--
-- match_rank is the ordering the caller does not have to reproduce:
--
--   0  the name, exactly            "drake"        -> Drake
--   1  the name starts with it      "kend"         -> Kendrick Lamar
--   2  a word of the name starts with it  "cenat"  -> Kai Cenat
--   3  a word of the full name does        "aubrey" -> Drake
--   4  anywhere in the name         "beast"        -> MrBeast
--   5  anywhere in the full name or the slug
--
-- then by score descending, then name, then id — the same total order the
-- board ranks by, so ties resolve identically on every call.
--
-- `change` is the score's movement over the trailing hour, derived the same
-- way home_momentum() derives it (oldest to newest within the window, null
-- below two points so a person with no history reads as "no movement yet"
-- rather than as genuinely flat). It exists so a result row can show a
-- direction without a second round trip.
--
-- SECURITY INVOKER: see the header. The gate below is the enforcement, not
-- RLS, so the answer does not change if a caller holds the service role.
-- Interpolating the needle into LIKE is safe because search_key() emits only
-- [a-z0-9] — no %, no _, no backslash can survive normalisation.

create or replace function public.search_people(
  p_query text,
  p_limit integer default 8
)
returns table (
  id            uuid,
  slug          text,
  display_name  text,
  category      text,
  avatar_url    text,
  current_score numeric,
  change        numeric,
  match_rank    integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with needle as (
    select public.search_key(p_query)   as key,
           public.search_terms(p_query) as terms,
           least(greatest(coalesce(p_limit, 8), 1), 25) as lim
  ),
  matched as (
    select p.id, p.slug, p.display_name, p.category, p.avatar_url, p.current_score,
           case
             when public.search_key(p.display_name) = n.key                                        then 0
             when public.search_key(p.display_name) like n.key || '%'                               then 1
             when ' ' || public.search_terms(p.display_name) like '% ' || n.terms || '%'            then 2
             when ' ' || public.search_terms(coalesce(p.full_name, '')) like '% ' || n.terms || '%' then 3
             when position(n.key in public.search_key(p.display_name)) > 0                          then 4
             else 5
           end as match_rank
      from public.people p, needle n
     where n.key is not null
       and n.key <> ''
       -- THE GATE. One predicate, in the database, ahead of every match rule.
       and p.is_discoverable
       and p.is_active
       and (
            position(n.key in public.search_key(p.display_name)) > 0
         or position(n.key in public.search_key(coalesce(p.full_name, ''))) > 0
         or position(n.key in public.search_key(p.slug)) > 0
       )
  ),
  moved as (
    select m.id as person_id,
           count(*)::int                                    as points,
           (array_agg(h.score order by h.recorded_at))[1]    as first_score,
           (array_agg(h.score order by h.recorded_at desc))[1] as last_score
      from matched m
      join lateral (
        select sh.score, sh.recorded_at
          from public.score_history sh
         where sh.person_id = m.id
           and sh.recorded_at >= now() - interval '1 hour'
         order by sh.recorded_at desc
         limit 240
      ) h on true
     group by m.id
  )
  select m.id, m.slug, m.display_name, m.category, m.avatar_url, m.current_score,
         case when v.points >= 2 then v.last_score - v.first_score end as change,
         m.match_rank
    from matched m
    left join moved v on v.person_id = m.id
   order by m.match_rank, m.current_score desc, m.display_name, m.id
   limit (select lim from needle)
$$;

comment on function public.search_people(text, integer) is
  'Phase 23: find a discoverable person by name, full name or slug. Partial, case- and punctuation-forgiving. is_discoverable is enforced here, not in the caller: a person who has not opted in is unreachable through this function at any limit and for any role.';

revoke execute on function public.search_people(text, integer) from public, anon;
grant  execute on function public.search_people(text, integer) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. What breaks first, and roughly when
-- -----------------------------------------------------------------------------
--
-- Sixteen rows today. The anchored half of the match (rank 0 and 1) rides the
-- three partial indexes above. The contains half — rank 4 and 5, "beast"
-- inside "mrbeast" — cannot: a b-tree can answer 'needle%' and nothing else,
-- so those branches are a sequential scan of the discoverable set with three
-- function calls per row.
--
-- That is the thing that breaks first, and it breaks by getting slow rather
-- than by getting wrong. A few hundred people is nothing (a scan of 500 rows
-- is well under a millisecond and the planner will not even consider anything
-- else). It stays comfortable into the low tens of thousands. Somewhere past
-- that — call it 50k discoverable people, or sooner if searches get frequent
-- enough that the per-row function calls matter — the fix is pg_trgm: a GIN
-- index on the same search_key() expressions turns the contains branch into
-- an index scan without changing a single match rule or a returned column.
-- It is deliberately not installed now: it is an extension the local test
-- harness does not have, and sixteen rows do not need it.
--
-- The second thing to go, much later, is the trailing-hour join for `change`:
-- it is bounded per matched person (limit 25 people x limit 240 rows) so it
-- does not grow with the roster, only with tick density.
-- =============================================================================
