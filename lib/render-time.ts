import "server-only";

import { cache } from "react";

/**
 * The request's render time, shared by a page and its rail so relative ages
 * ("3m") agree everywhere on the page and between server and client.
 * Memoised per request with React cache().
 */
export const getRenderedAt = cache((): number => Date.now());
