# Momentum Terminal

A social data terminal where users take **HIGH** or **LOW** positions on individual people. Each person has a continuously updating Momentum Score driven by their observable real-world data. Users profit when a score moves in their predicted direction; the platform is the sole counterparty.

> **Status: Phase 1 (Foundation).** This repository currently contains the project scaffold, the database schema, seed data, row level security, and email/password authentication. The scoring Engine, data-source integrations, LLM layer and product UI are later phases.

## Stack

| Layer      | Choice                                    |
| ---------- | ----------------------------------------- |
| Framework  | Next.js 16 (App Router, TypeScript)       |
| Database   | PostgreSQL 17 on Supabase                 |
| Auth       | Supabase Auth (email + password)          |
| Styling    | Tailwind CSS 4 (installed, no design yet) |
| Deployment | Vercel                                    |

## Getting started

```bash
npm install
cp .env.local.example .env.local   # then fill in the values (see below)
npm run dev                        # http://localhost:3000
```

Other scripts:

| Script              | What it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `npm run build`     | Production build                                                        |
| `npm run typecheck` | `tsc --noEmit`                                                          |
| `npm run lint`      | ESLint (Next.js core-web-vitals + TypeScript rules)                     |
| `npm run db:link`   | Link the Supabase CLI to the project (one time, after `npx supabase login`) |
| `npm run db:push`   | Apply any migrations in `supabase/migrations` that are not yet applied  |
| `npm run db:types`  | Regenerate `types/database.ts` from the linked database                 |

## Environment variables

All variables are listed in `.env.local.example`. Values come from the Supabase dashboard under **Project Settings → API Keys**.

| Variable                               | Where it is used             | Notes                                                                                    |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | browser + server             | `https://<project-ref>.supabase.co`                                                      |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server             | Publishable key (`sb_publishable_…`). The legacy anon JWT also works. Subject to RLS.    |
| `SUPABASE_SERVICE_ROLE_KEY`            | server only                  | Secret key (`sb_secret_…`) or legacy `service_role` JWT. **Bypasses RLS.** Never public. |
| `NEXT_PUBLIC_SITE_URL`                 | server (auth redirect links) | `http://localhost:3000` locally, your Vercel URL in production.                          |

`lib/env.ts` is the only place that reads `process.env`; everything else calls its helpers.

## Project structure

```
app/
  (auth)/
    actions.ts            Server Actions: login, signup, signOut
    login/page.tsx        Minimal login page
    signup/page.tsx       Minimal signup page
  auth/callback/route.ts  Handles email confirmation / magic-link redirects
  account/page.tsx        Minimal protected page (proves the auth loop end to end)
  layout.tsx, page.tsx, globals.css
components/
  auth/                   LoginForm, SignupForm, SignOutButton
lib/
  env.ts                  Environment variable access
  supabase.ts             Typed browser client (Client Components)
  supabase-server.ts      Typed cookie-based server client (Server Components, Actions, Route Handlers)
  supabase-admin.ts       Typed service-role client (server only, bypasses RLS)
  supabase-proxy.ts       Session refresh + route guards used by proxy.ts
  auth.ts                 Session helpers: getCurrentUser, getCurrentSession, getCurrentProfile, requireUser
  money.ts                Integer-cents formatting helpers
proxy.ts                  Next.js proxy (formerly middleware): refreshes sessions, guards routes
supabase/
  config.toml             Minimal Supabase CLI config
  migrations/             SQL migrations (see below)
types/
  database.ts             Generated from the schema (npm run db:types)
  index.ts                Row aliases and closed vocabularies
```

## Database

All monetary amounts are **integer cents** stored in `bigint` columns. Floating point is never used for money. Scores are `numeric` on a 0–100 scale.

### Migrations

| File                                | Contents                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `20260905204224_initial_schema.sql` | All 11 tables, constraints, indexes and comments                            |
| `20260905204557_rls_policies.sql`   | RLS enabled everywhere + every policy                                       |
| `20260905205313_auth_triggers.sql`  | `handle_new_user` trigger, email-sync trigger, `username_available()` RPC   |
| `20260905205726_seed_phase1.sql`    | 16 people, the Drake ↔ Kendrick Lamar inverse pair, 8 inactive data sources |

These four migrations are already applied to the `Momentum Terminal` Supabase project and recorded in `supabase_migrations.schema_migrations` under the same versions, so `npm run db:push` treats them as applied and only pushes new files.

To add a migration: create `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, run `npm run db:push`, then `npm run db:types`.

### Tables

| Table                 | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `users`               | Profile + wallet for each `auth.users` row                          |
| `people`              | Each tracked individual (the core entity)                           |
| `data_sources`        | Pluggable registry of external feeds                                |
| `person_data_sources` | Which sources feed which person, with the external identifier       |
| `inverse_pairs`       | Unordered pairs whose scores move against each other                |
| `positions`           | A user's HIGH/LOW position on a person                              |
| `transactions`        | Wallet ledger (`DEPOSIT`, `ALLOCATION`, `REDEMPTION`, `WITHDRAWAL`) |
| `signals`             | Incoming data points before/after Engine processing                 |
| `score_history`       | Score time series per person                                        |
| `portfolio_history`   | Portfolio value time series per user                                |
| `behavioral_events`   | Interaction events for the future recommendation algorithm          |

### Row level security

RLS is enabled on every table. The `anon` role has no policies anywhere.

| Tables                                                                                       | Authenticated users                                                    | Service role       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ |
| `users`                                                                                      | read own row; update own `username`, `display_name`, `avatar_url` only | full               |
| `positions`, `transactions`, `portfolio_history`, `behavioral_events`                        | select / insert / update / delete own rows                             | full               |
| `people`, `data_sources`, `person_data_sources`, `inverse_pairs`, `score_history`, `signals` | read all                                                               | full (only writer) |

Wallet balances and `is_admin` can only be changed through the service role: table-level `UPDATE` is revoked from clients and re-granted on the three profile columns.

## Authentication

- **Signup** (`/signup`): the Server Action validates the input, pre-checks the username through the `username_available()` RPC, then calls `supabase.auth.signUp` with `username` and `display_name` in the user metadata.
- The `on_auth_user_created` trigger on `auth.users` inserts the `public.users` row with `wallet_balance_cents = 100000` and `buying_power_cents = 100000` ($1,000 demo credit) and writes a matching `DEPOSIT` transaction. If the requested username is taken at insert time it retries with a random suffix, so signup never fails on a username race.
- If **Confirm email** is enabled in Supabase Auth settings, the user gets a confirmation email; the link lands on `/auth/callback`, which exchanges the code for a session. If it is disabled, signup signs the user in immediately.
- **Login** (`/login`): `signInWithPassword`, then redirect to `next` (defaults to `/account`).
- `proxy.ts` runs on every request, refreshes expired sessions, sends signed-out users away from `/account`, and signed-in users away from `/login` and `/signup`.
- In server code use `getCurrentUser()` / `requireUser()` from `lib/auth.ts` for anything that depends on identity; they verify the session with Supabase Auth rather than trusting the cookie.

Set the Supabase Auth **Site URL** and **Redirect URLs** (Authentication → URL Configuration) to include your local and Vercel origins plus `/auth/callback`, or confirmation links will not land back in the app.

## Phase 1 scope

Built:

- Next.js scaffold with `/app`, `/lib`, `/components`, `/types`
- Full schema, indexes, constraints, RLS policies, auth triggers, seed data
- Typed Supabase clients (browser, server, service role) and generated types
- Email/password signup and login with minimal functional pages

Deliberately not built yet: the scoring Engine, any data-source integration, the LLM layer, person profiles, feeds, portfolio pages, and any visual design.
