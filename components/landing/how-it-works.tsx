import { HOW } from "@/lib/landing/copy";

/** Three beats. Numbered, so the order reads as an order. */
export function HowItWorks() {
  return (
    <section aria-labelledby="how-heading" className="flex flex-col gap-8">
      <h2 id="how-heading" className="text-label text-fg-muted">
        {HOW.title}
      </h2>
      <ol className="grid gap-8 md:grid-cols-3 md:gap-10">
        {HOW.beats.map((beat) => (
          <li key={beat.number} className="flex flex-col gap-3">
            <span className="num text-sm text-fg-faint" aria-hidden>
              {beat.number}
            </span>
            <h3 className="text-xl font-semibold tracking-tight text-fg">{beat.title}</h3>
            <p className="text-base leading-relaxed text-fg-muted">{beat.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
