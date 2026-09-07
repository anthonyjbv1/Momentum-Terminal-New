import { describe, expect, it } from "vitest";

import { authorizeIngestRequest, extractPresentedSecret } from "./auth";

const SECRET = "s3cret-value";

describe("authorizeIngestRequest", () => {
  it("fails closed when no secret is configured", () => {
    expect(authorizeIngestRequest(new Headers({ "x-ingest-secret": SECRET }), null)).toEqual({
      ok: false,
      status: 503,
      message: "INGEST_SECRET is not configured on the server.",
    });
  });

  it("rejects missing or wrong secrets", () => {
    expect(authorizeIngestRequest(new Headers(), SECRET)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeIngestRequest(new Headers({ "x-ingest-secret": "nope" }), SECRET)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeIngestRequest(new Headers({ authorization: "Bearer nope" }), SECRET)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeIngestRequest(new Headers({ "x-ingest-secret": SECRET.slice(0, -1) }), SECRET)).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts the secret via header or bearer token", () => {
    expect(authorizeIngestRequest(new Headers({ "x-ingest-secret": SECRET }), SECRET)).toEqual({ ok: true });
    expect(authorizeIngestRequest(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET)).toEqual({ ok: true });
  });

  it("extracts the presented secret from either location", () => {
    expect(extractPresentedSecret(new Headers({ "x-ingest-secret": " abc " }))).toBe("abc");
    expect(extractPresentedSecret(new Headers({ authorization: "bearer xyz" }))).toBe("xyz");
    expect(extractPresentedSecret(new Headers({ authorization: "Basic xyz" }))).toBeNull();
  });
});
