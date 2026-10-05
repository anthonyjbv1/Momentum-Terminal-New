import "server-only";

import { headers } from "next/headers";

/**
 * Whether the request comes from a phone (the tab-switch lag fix,
 * 2026-10-04). The desktop rail (`app/(app)/@rail`) is a parallel route that
 * renders on every navigation whatever the viewport, while the aside it fills
 * is `hidden` below `lg`; on a phone its reads were pure cost. The rail pages
 * ask this first and render nothing for a phone.
 *
 * Read from the client hint when the browser sends one, else from the
 * user agent: iPhone, iPod, Android phones (Android with "Mobile"), Windows
 * Phone. An iPad is not a phone (its Safari renders the rail at landscape
 * width), and a desktop window narrowed below `lg` keeps the rail hidden by
 * CSS as before. A wrong guess costs a hidden rail on a phone-sized desktop
 * window or three queries on an unusual phone; it never changes what is shown.
 */
const PHONE_UA = /iPhone|iPod|Windows Phone|Android(?=.*Mobile)/i;

export async function isPhoneRequest(): Promise<boolean> {
  const list = await headers();
  const hint = list.get("sec-ch-ua-mobile");
  if (hint === "?1") return true;
  if (hint === "?0") return false;
  return PHONE_UA.test(list.get("user-agent") ?? "");
}
