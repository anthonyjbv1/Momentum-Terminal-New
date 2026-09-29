"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * The picture inside an Avatar, with the fallback the server cannot do: if
 * the image fails to load (a platform URL that has expired, a file that is
 * gone), it is taken out and the initials beneath show instead.
 */
export function AvatarImage({ src, sizes, initials }: { src: string; sizes: string; initials: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span aria-hidden>{initials}</span>;
  return <Image src={src} alt="" fill sizes={sizes} unoptimized className="object-cover" onError={() => setFailed(true)} />;
}
