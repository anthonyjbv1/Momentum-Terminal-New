/** Inline form error: quiet red surface, read by screen readers as an alert. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
      {message}
    </p>
  );
}
