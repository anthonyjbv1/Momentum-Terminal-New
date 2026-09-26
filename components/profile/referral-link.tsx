"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PROFILE } from "@/lib/profile/copy";

/** The member's referral link, selectable and copyable. It records who referred whom, and does nothing else. */
export function ReferralLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={link} aria-label={PROFILE.referral.title} className="text-sm text-fg-secondary" onFocus={(event) => event.currentTarget.select()} />
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="shrink-0"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        <span aria-live="polite">{copied ? PROFILE.referral.copied : PROFILE.referral.copy}</span>
      </Button>
    </div>
  );
}
