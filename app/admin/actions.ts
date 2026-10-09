"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/admin/auth";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * THE REVIEW QUEUE'S ACTIONS (Phase 29). Each one is a plain HTML form on
 * /admin posting to this Server Action, which calls the matching admin RPC
 * AS THE SIGNED-IN OPERATOR through their own client — the RPC's own
 * assert_admin() is the boundary, and requireAdmin() here is the page's
 * courtesy check before it. Every RPC writes admin_audit_log itself, and that
 * table refuses updates and deletes whatever role attempts them, so this
 * file cannot act without leaving a row.
 *
 * Nothing is edited here that the RPCs do not expose: no setting, no balance.
 * What an operator can do from the console is exactly: freeze or unfreeze an
 * account, halt a person or lift a halt, set a person's trading mode, add or
 * remove an excluded party, move an alert through open → reviewing →
 * resolved / dismissed, and, since the market controls of 2026-10-05, set a
 * person's or a tier's market parameter, reset a person's market, and void a
 * signal or a narrative. Each of those is its own audit-logged RPC; the
 * columns refuse any other write (a trigger), so there is no unlogged path.
 *
 * The outcome comes back as a notice in the query string (a sentence, never
 * an object), so the page is one render with no client JavaScript.
 */

const ACTIONS = ["freeze", "unfreeze", "halt", "lift_halt", "set_mode", "exclude", "unexclude", "alert_status", "set_parameter", "set_tier_parameter", "set_engine_parameter", "reset_market", "void_signal", "void_narrative", "hide_signal", "unhide_signal", "lift_allegation_hold"] as const;
/** The logged Engine parameters (2026-10-09). */
const ENGINE_PARAMETERS = ["gravity_rate"] as const;
type Action = (typeof ACTIONS)[number];

const PERSON_PARAMETERS = ["tier", "pricing_mode_override", "depth_units_override", "decay_half_life_ticks_override", "premium_cap_cents_override", "shorting_override"] as const;
const TIER_PARAMETERS = [
  "pricing_mode",
  "depth_units",
  "decay_half_life_ticks",
  "premium_cap_cents",
  "min_hold_seconds",
  "max_order_share_of_depth",
  "aggregate_exposure_cap_units",
  "breaker_premium_cents",
  "breaker_window_seconds",
  "breaker_halt_seconds",
  "breaker_price_cents",
  "shorting_allowed",
  "alert_on_halt",
] as const;

/**
 * A parameter value as the form posts it, as the JSON the RPC takes: blank
 * clears (null), "true" / "false" are booleans, a number is a number, and
 * anything else is the string itself (a pricing mode, a tier).
 */
function parameterValue(raw: string): string | number | boolean | null {
  if (raw === "") return null;
  if (raw === "true" || raw === "false") return raw === "true";
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(form: FormData, key: string, max = 500): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function uuid(form: FormData, key: string): string | null {
  const value = text(form, key, 40);
  return UUID.test(value) ? value.toLowerCase() : null;
}

function finish(notice: string): never {
  revalidatePath("/admin");
  redirect(`/admin?notice=${encodeURIComponent(notice.slice(0, 300))}#market`);
}

export async function marketAction(form: FormData): Promise<void> {
  await requireAdmin();
  const action = text(form, "action", 40) as Action;
  if (!ACTIONS.includes(action)) finish("Unknown action.");

  const supabase = await createSupabaseServerClient();
  const alertId = uuid(form, "alert_id");
  const note = text(form, "note");

  let outcome: { error: { message: string } | null };
  try {
    switch (action) {
      case "freeze": {
        const userId = uuid(form, "user_id");
        if (!userId) finish("Freeze needs an account id.");
        if (!note) finish("Freeze needs a reason.");
        outcome = await supabase.rpc("admin_freeze_account", { p_user_id: userId, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "unfreeze": {
        const userId = uuid(form, "user_id");
        if (!userId) finish("Unfreeze needs an account id.");
        outcome = await supabase.rpc("admin_unfreeze_account", { p_user_id: userId, p_note: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "halt": {
        const personId = uuid(form, "person_id");
        const minutes = Number(text(form, "minutes", 10));
        if (!personId) finish("Halt needs a person.");
        if (!Number.isFinite(minutes) || minutes <= 0) finish("Halt needs a positive number of minutes.");
        if (!note) finish("Halt needs a reason.");
        outcome = await supabase.rpc("admin_halt_person", { p_person_id: personId, p_seconds: Math.round(minutes * 60), p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "lift_halt": {
        const personId = uuid(form, "person_id");
        if (!personId) finish("Lift needs a person.");
        outcome = await supabase.rpc("admin_lift_halt", { p_person_id: personId, p_note: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "set_mode": {
        const personId = uuid(form, "person_id");
        const mode = text(form, "mode", 20);
        if (!personId) finish("Mode needs a person.");
        if (mode !== "tradeable" && mode !== "display_only" && mode !== "paused") finish("Mode must be tradeable, display_only or paused.");
        if (!note) finish("A mode change needs a reason.");
        outcome = await supabase.rpc("admin_set_trading_mode", { p_person_id: personId, p_mode: mode, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "exclude": {
        const userId = uuid(form, "user_id");
        const personId = uuid(form, "person_id");
        if (!userId) finish("Exclude needs an account id.");
        if (!note) finish("Exclude needs a reason.");
        // The generated signature marks p_person_id required; the SQL default is
        // null (every market), so a blank person is passed as null explicitly.
        outcome = await supabase.rpc("admin_add_excluded_party", { p_user_id: userId, p_person_id: personId as unknown as string, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "unexclude": {
        const id = uuid(form, "excluded_party_id");
        if (!id) finish("Remove needs the exclusion's id.");
        outcome = await supabase.rpc("admin_remove_excluded_party", { p_excluded_party_id: id, p_note: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "alert_status": {
        const status = text(form, "status", 20);
        if (!alertId) finish("The alert's id is missing.");
        if (status !== "open" && status !== "reviewing" && status !== "resolved" && status !== "dismissed") finish("Status must be open, reviewing, resolved or dismissed.");
        outcome = await supabase.rpc("admin_resolve_alert", { p_alert_id: alertId, p_status: status, p_note: note });
        break;
      }
      case "set_parameter": {
        const personId = uuid(form, "person_id");
        const parameter = text(form, "parameter", 40) as (typeof PERSON_PARAMETERS)[number];
        if (!personId) finish("A parameter change needs a person.");
        if (!PERSON_PARAMETERS.includes(parameter)) finish("Unknown person parameter.");
        if (!note) finish("A parameter change needs a reason.");
        outcome = await supabase.rpc("admin_set_person_market_parameter", { p_person_id: personId, p_parameter: parameter, p_value: parameterValue(text(form, "value", 40)), p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "set_tier_parameter": {
        const tier = text(form, "tier", 40);
        const parameter = text(form, "parameter", 40) as (typeof TIER_PARAMETERS)[number];
        if (tier !== "public_figure" && tier !== "private_individual") finish("Unknown tier.");
        if (!TIER_PARAMETERS.includes(parameter)) finish("Unknown tier parameter.");
        if (!note) finish("A tier parameter change needs a reason.");
        outcome = await supabase.rpc("admin_set_tier_market_parameter", { p_tier: tier, p_parameter: parameter, p_value: parameterValue(text(form, "value", 40)), p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "set_engine_parameter": {
        const parameter = text(form, "parameter", 40) as (typeof ENGINE_PARAMETERS)[number];
        const value = parameterValue(text(form, "value", 40));
        if (!ENGINE_PARAMETERS.includes(parameter)) finish("Unknown Engine parameter.");
        if (typeof value !== "number") finish("An Engine parameter needs a number.");
        if (!note) finish("An Engine parameter change needs a reason.");
        outcome = await supabase.rpc("admin_set_engine_parameter", { p_key: parameter, p_value: value, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "reset_market": {
        const personId = uuid(form, "person_id");
        if (!personId) finish("A reset needs a person.");
        if (!note) finish("A reset needs a reason.");
        outcome = await supabase.rpc("admin_reset_market", { p_person_id: personId, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "void_signal": {
        const signalId = uuid(form, "signal_id");
        if (!signalId) finish("A void needs the signal's id.");
        if (!note) finish("A void needs a reason.");
        outcome = await supabase.rpc("admin_void_signal", { p_signal_id: signalId, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "hide_signal": {
        const signalId = uuid(form, "signal_id");
        if (!signalId) finish("A hide needs the signal's id.");
        if (!note) finish("A hide needs a reason.");
        outcome = await supabase.rpc("admin_hide_signal", { p_signal_id: signalId, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "unhide_signal": {
        const signalId = uuid(form, "signal_id");
        if (!signalId) finish("An unhide needs the signal's id.");
        if (!note) finish("An unhide needs a reason.");
        outcome = await supabase.rpc("admin_unhide_signal", { p_signal_id: signalId, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "lift_allegation_hold": {
        const signalId = uuid(form, "signal_id");
        if (!signalId) finish("A lift needs the signal's id.");
        if (!note) finish("A lift needs a reason.");
        outcome = await supabase.rpc("admin_lift_allegation_hold", { p_signal_id: signalId, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
      case "void_narrative": {
        const narrativeId = uuid(form, "narrative_id");
        if (!narrativeId) finish("A void needs the narrative's id.");
        if (!note) finish("A void needs a reason.");
        outcome = await supabase.rpc("admin_void_narrative", { p_narrative_id: narrativeId, p_reason: note, p_alert_id: alertId ?? undefined });
        break;
      }
    }
  } catch (error) {
    finish(`Failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (outcome.error) finish(`Refused: ${outcome.error.message}`);
  finish(`Done: ${action.replace("_", " ")}.`);
}
