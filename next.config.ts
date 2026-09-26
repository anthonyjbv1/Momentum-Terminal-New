import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The OG image route (Phase 28) reads its vendored WOFF files from the
  // project root at request time; trace them into that route's bundle so
  // the deployed function carries them.
  outputFileTracingIncludes: {
    "/og": ["./lib/og/fonts/*.woff"],
  },
  // Phase 32: a profile photo is posted to a Server Action. The bucket
  // takes up to 2 MB and the action refuses more; the body limit sits just
  // above that so the refusal is the action's plain sentence, not a 413.
  experimental: {
    serverActions: { bodySizeLimit: "3mb" },
  },
};

export default nextConfig;
