import { describe, expect, it } from "vitest";

import { authorizeSharedSecret, extractPresentedSecret } from "./api-auth";
import { authorizeIngestRequest } from "./ingest/auth";

const SECRET = "s3cret-value";
const OPTIONS = { headerName: "x-engine-secret", envName: "ENGINE_SECRET" };

describe("authorizeSharedSecret", () => {
  it("fails closed when no secret is configured", () => {
    expect(authorizeSharedSecret(new Headers({ "x-engine-secret": SECRET }), null, OPTIONS)).toEqual({
      ok: false,
      status: 503,
      message: "ENGINE_SECRET is not configured on the server.",
    });
  });

  it("rejects missing or wrong secrets", () => {
    expect(authorizeSharedSecret(new Headers(), SECRET, OPTIONS)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeSharedSecret(new Headers({ "x-engine-secret": "nope" }), SECRET, OPTIONS)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeSharedSecret(new Headers({ authorization: "Bearer nope" }), SECRET, OPTIONS)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeSharedSecret(new Headers({ "x-engine-secret": SECRET.slice(0, -1) }), SECRET, OPTIONS)).toMatchObject({ ok: false, status: 401 });
    // The ingest header does not unlock the engine endpoint.
    expect(authorizeSharedSecret(new Headers({ "x-ingest-secret": SECRET }), SECRET, OPTIONS)).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts the secret via the named header or a bearer token", () => {
    expect(authorizeSharedSecret(new Headers({ "x-engine-secret": SECRET }), SECRET, OPTIONS)).toEqual({ ok: true });
    expect(authorizeSharedSecret(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET, OPTIONS)).toEqual({ ok: true });
  });

  it("extracts the presented secret from either location", () => {
    expect(extractPresentedSecret(new Headers({ "x-engine-secret": " abc " }), "x-engine-secret")).toBe("abc");
    expect(extractPresentedSecret(new Headers({ authorization: "bearer xyz" }), "x-engine-secret")).toBe("xyz");
    expect(extractPresentedSecret(new Headers({ authorization: "Basic xyz" }), "x-engine-secret")).toBeNull();
  });

  it("keeps the ingest wrapper working", () => {
    expect(authorizeIngestRequest(new Headers({ "x-ingest-secret": SECRET }), SECRET)).toEqual({ ok: true });
    expect(authorizeIngestRequest(new Headers(), null)).toMatchObject({ ok: false, status: 503 });
  });
});
