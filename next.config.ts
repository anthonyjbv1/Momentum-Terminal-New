import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The OG image route (Phase 28) reads its vendored WOFF files from the
  // project root at request time; trace them into that route's bundle so
  // the deployed function carries them.
  outputFileTracingIncludes: {
    "/og": ["./lib/og/fonts/*.woff"],
  },
};

export default nextConfig;
