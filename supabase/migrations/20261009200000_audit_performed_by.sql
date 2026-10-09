-- =============================================================================
-- WHO PERFORMED AN ADMIN ACTION (2026-10-09).
--
-- admin_audit_log.actor_id was NOT NULL and a user: every row named a
-- human. On 2026-10-09 at 11:54 UTC a display-only hide was applied by
-- Claude Code on the operator's instruction through direct statements,
-- outside admin_hide_signal(), and its audit row carried the operator as
-- the actor. That row stands untouched; this makes the truth expressible:
--
--   actor_id      now nullable: the admin whose session performed the action
--   performed_by  text: who performed it when no admin session did
--                 ("Claude Code", a migration, a scheduled job)
--   every row has one or the other (the check below)
--
-- The admin functions still write actor_id from assert_admin(); only a row
-- written outside them carries performed_by. The console shows whichever
-- is set.
-- =============================================================================

alter table public.admin_audit_log alter column actor_id drop not null;
alter table public.admin_audit_log add column performed_by text;
alter table public.admin_audit_log
  add constraint admin_audit_log_performed_by_nonempty check (performed_by is null or length(trim(performed_by)) > 0),
  add constraint admin_audit_log_actor_or_performer   check (actor_id is not null or performed_by is not null);

comment on column public.admin_audit_log.actor_id     is 'The admin whose session performed the action; null when no admin session did (see performed_by).';
comment on column public.admin_audit_log.performed_by is 'Who performed the action when no admin session did: an agent, a migration, a job. Set only on rows written outside the admin functions.';
