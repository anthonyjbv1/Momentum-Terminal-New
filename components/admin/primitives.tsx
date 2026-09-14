import Link from "next/link";

import type { Window } from "@/lib/admin/data";
import { WINDOWS } from "@/lib/admin/data";

/**
 * The operator console's small parts. Server components, no client JavaScript:
 * every control here is a link, so the page is one render with no hydration and
 * nothing to go stale between the read and the paint.
 *
 * Styling lives in app/admin/admin.css under `.adm`. None of these touch the
 * consumer design system.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "plain";

export function Panel({
  id,
  title,
  hint,
  right,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="adm-panel">
      <header>
        <h2>{title}</h2>
        {hint ? <p>{hint}</p> : null}
        {right ? <div className="adm-right">{right}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Stats({ children }: { children: React.ReactNode }) {
  return <dl className="adm-stats">{children}</dl>;
}

export function Stat({ label, value, sub, tone = "plain" }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  return (
    <div className="adm-stat" data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}

export function Badge({ tone = "plain", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className="adm-b" data-tone={tone}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="adm-empty">{children}</p>;
}

export function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="adm-scroll">{children}</div>;
}

/**
 * A magnitude meter: one hue, no scale games, the number always beside it so
 * the bar is a second reading of a value that is already written down.
 */
export function Meter({ ratio, label, done }: { ratio: number | null; label: string; done?: boolean }) {
  const clamped = ratio === null ? 0 : Math.max(0, Math.min(1, ratio));
  return (
    <span className="adm-meter-row">
      <span className="adm-meter" data-tone={done ? "ok" : undefined} role="img" aria-label={label}>
        <span style={{ width: `${(clamped * 100).toFixed(1)}%` }} />
      </span>
      <span className="n">{label}</span>
    </span>
  );
}

/** The time-window control: four links that only change the query string. */
export function WindowTabs({ current }: { current: Window }) {
  return (
    <span className="adm-tabs">
      {WINDOWS.map((window) => (
        <Link key={window.id} href={window.id === "24h" ? "/admin" : `/admin?window=${window.id}`} aria-current={window.id === current ? "true" : undefined}>
          {window.label}
        </Link>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting. Everything an operator reads is a number, so these are shared.
// ---------------------------------------------------------------------------

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Costs are small; show enough places that a fraction of a cent is not rounded to nothing. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export function percent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/** Absolute UTC, because an operator comparing this to a log needs the same clock. */
export function stamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

/** How long ago, in the coarsest unit that still says something. */
export function age(value: string | null | undefined, now: number): string {
  if (!value) return "never";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(1)}h ago`;
  return `${(hours / 24).toFixed(1)}d ago`;
}

export function hours(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(value < 10 ? 2 : 1)}h`;
}
