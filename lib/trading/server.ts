import "server-only";

import { cache } from "react";

import { getCurrentProfile, getCurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase-server";

import type { OrderSide } from "./direction";
import { EMPTY_POSITION, cents, toOrderResult, toPositionSummary, type Cents, type OrderResult, type PositionSummary, type ViewerTradingState } from "./model";

export type { ViewerTradingState };

/**
 * The trading flow's server-side calls. Every one runs as the signed-in user
 * through their own RLS-scoped client, so the RPCs see auth.uid() and a user
 * can only ever read or move their own money.
 */

/** The signed-in user's position on a person, or null when signed out. Never throws: a failed read is an empty position. */
export const getMyPosition = cache(async (personId: string): Promise<PositionSummary | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_position", { p_person_id: personId });
  if (error) {
    console.warn("[trading] my_position failed:", error.message);
    return { personId, ...EMPTY_POSITION };
  }
  return toPositionSummary(data, personId);
});

/** The signed-in user's paper balance in cents, or null when signed out. */
export const getWalletBalanceCents = cache(async (): Promise<Cents | null> => {
  const profile = await getCurrentProfile().catch(() => null);
  if (!profile) return null;
  const value = Number(profile.wallet_balance_cents);
  return Number.isSafeInteger(value) ? cents(value) : cents(0);
});

/** Everything the profile page needs to know about the viewer's trading state on a person. */
export async function getViewerTradingState(personId: string): Promise<ViewerTradingState> {
  const [balanceCents, position] = await Promise.all([getWalletBalanceCents(), getMyPosition(personId)]);
  return { signedIn: balanceCents !== null, balanceCents, position };
}

export interface PlaceOrderInput {
  personId: string;
  side: OrderSide;
  units: number;
  /** The price the user confirmed, in cents per unit, for the tolerance check. */
  quotedPriceCents: number | null;
  surface: string | null;
}

/** Calls place_order() as the signed-in user. Rejections come back as values; only transport failures throw. */
export async function placeOrderAsUser(input: PlaceOrderInput): Promise<OrderResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("place_order", {
    p_person_id: input.personId,
    p_side: input.side,
    p_units: input.units,
    // Both default to null in SQL; an omitted argument is the same as null.
    p_quoted_price_cents: input.quotedPriceCents ?? undefined,
    p_surface: input.surface ?? undefined,
  });
  if (error) throw new Error(error.message);
  return toOrderResult(data, input.personId);
}
