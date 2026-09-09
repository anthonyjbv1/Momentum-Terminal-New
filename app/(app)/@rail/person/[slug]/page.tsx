import { getCurrentUser } from "@/lib/auth";
import { getPersonBySlug, getPersonSignals, getRenderedAt } from "@/lib/person/profile";
import { SignalsList } from "@/components/person/signals-list";

// Mirrors the page: the rail shows whatever has landed as of this request.
export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;

/**
 * The person page's desktop rail: the signal list, beside the score. The
 * reads are shared with the page through React cache(), so the rail costs
 * no extra queries. Unknown slugs render nothing; the page itself 404s.
 */
export default async function PersonRail({ params }: { params: Params }) {
  const { slug } = await params;
  const [person, user] = await Promise.all([getPersonBySlug(slug).catch(() => null), getCurrentUser().catch(() => null)]);
  if (!person) return null;

  const signals = await getPersonSignals(person.id);

  return <SignalsList items={signals} personId={person.id} personName={person.displayName} loggingEnabled={Boolean(user)} renderedAt={getRenderedAt()} />;
}
