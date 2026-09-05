/**
 * Single place that reads environment variables.
 *
 * NEXT_PUBLIC_* variables are inlined into the browser bundle at build time,
 * which only works when they are referenced as literal `process.env.NAME`
 * expressions — hence no dynamic lookups here.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.local.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Supabase project URL, e.g. https://<project-ref>.supabase.co */
export function getSupabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/**
 * Publishable key (sb_publishable_...) or legacy anon JWT. Safe in the browser;
 * all queries made with it are subject to Row Level Security.
 */
export function getSupabasePublishableKey(): string {
  return required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * Secret key (sb_secret_...) or legacy service_role JWT. SERVER ONLY.
 * Bypasses Row Level Security — only read this from trusted server code.
 */
export function getSupabaseServiceRoleKey(): string {
  return required(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY,
  );
}

/** Public base URL of the app, used to build auth redirect links. */
export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}
