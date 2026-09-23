import { WINDOWS, readBehaviour, readEngine, readIngestion, readLevers, readLlmCost, readWaitlist, type Window } from "@/lib/admin/data";
import { getRenderedAt } from "@/lib/render-time";
import { BehaviourSection } from "@/components/admin/behaviour";
import { EngineSection, LeversSection } from "@/components/admin/engine";
import { IngestionSection } from "@/components/admin/ingestion";
import { LlmCostSection } from "@/components/admin/llm-cost";
import { WaitlistSection } from "@/components/admin/waitlist";

/**
 * /admin — one page, six sections, everything on it read at request time.
 *
 * Each read re-checks the admin flag itself (lib/admin/data.ts), so the layout's
 * check is a convenience and not the boundary. `?window=` moves the two
 * time-scoped sections; everything else is current state.
 */

export const dynamic = "force-dynamic";

function parseWindow(value: string | string[] | undefined): Window {
  const first = Array.isArray(value) ? value[0] : value;
  return WINDOWS.find((window) => window.id === first)?.id ?? "24h";
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ window?: string | string[] }> }) {
  const window = parseWindow((await searchParams).window);
  // One clock for the whole page, so every "3m ago" on it agrees.
  const now = getRenderedAt();

  const [llm, ingestion, engine, levers, behaviour, waitlist] = await Promise.all([
    readLlmCost(window),
    readIngestion(),
    readEngine(),
    readLevers(),
    readBehaviour(window),
    readWaitlist(),
  ]);

  return (
    <>
      <LlmCostSection report={llm} />
      <IngestionSection report={ingestion} now={now} />
      <EngineSection report={engine} now={now} />
      <LeversSection levers={levers} />
      <BehaviourSection report={behaviour} />
      <WaitlistSection report={waitlist} now={now} />
    </>
  );
}
