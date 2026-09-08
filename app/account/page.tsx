import { redirect } from "next/navigation";

/** The Phase 1 account page now lives at /profile. */
export default function AccountPage() {
  redirect("/profile");
}
