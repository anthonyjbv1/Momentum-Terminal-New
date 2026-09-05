import { signOut } from "@/app/(auth)/actions";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="rounded border px-4 py-2 text-sm">
        Sign out
      </button>
    </form>
  );
}
