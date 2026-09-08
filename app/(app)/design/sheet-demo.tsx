"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonText } from "@/components/ui/skeleton";

/** Opens a sheet so the banner-above-modal rule can be seen. */
export function SheetDemo() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open a sheet
      </Button>
      <Sheet open={open} onClose={close} title="A modal surface" description="Note the banner and its countdown stay visible above this sheet.">
        <SkeletonText lines={4} />
        <PhaseNotice phase="Design system" className="mt-5">
          Bottom sheet on mobile, centred dialog on desktop. Escape or the backdrop closes it.
        </PhaseNotice>
      </Sheet>
    </>
  );
}
