import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

const allow = { limit: async () => ({ success: true }) };
const deny = { limit: async () => ({ success: false }) };
const secrets = {
  TYPESAFE_API_KEY: "test-key",
  CONTINUATION_SECRET: "test-secret-that-is-at-least-thirty-two-characters",
};
const unusedSessions = {
  idFromName: () => ({}),
  get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
};

test("API rejects unsupported methods and media types without provider calls", async () => {
  const methodResponse = await worker.fetch(
    new Request("https://example.test/api/find"),
    { ...secrets, SEARCH_RATE_LIMITER: allow, SEARCH_SESSIONS: unusedSessions },
  );
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "POST");

  const mediaResponse = await worker.fetch(
    new Request("https://example.test/api/find", { method: "POST", body: "{}" }),
    { ...secrets, SEARCH_RATE_LIMITER: allow, SEARCH_SESSIONS: unusedSessions },
  );
  assert.equal(mediaResponse.status, 415);
  assert.equal(mediaResponse.headers.get("cache-control"), "no-store");
});

test("API returns safe configuration and rate-limit errors", async () => {
  const request = () => new Request("https://example.test/api/find", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify({ name: "Jane Smith" }),
  });
  const configurationResponse = await worker.fetch(
    request(),
    { TYPESAFE_API_KEY: "", CONTINUATION_SECRET: "", SEARCH_RATE_LIMITER: allow, SEARCH_SESSIONS: unusedSessions },
  );
  assert.equal(configurationResponse.status, 503);
  assert.deepEqual(await configurationResponse.json(), { error: "Service is not configured." });

  const limitedResponse = await worker.fetch(
    request(),
    { ...secrets, SEARCH_RATE_LIMITER: deny, SEARCH_SESSIONS: unusedSessions },
  );
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get("retry-after"), "60");
});

test("API creates a Durable Object session and returns a bounded continuation", async () => {
  let internalBody: unknown;
  const sessions = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        internalBody = JSON.parse(String(init?.body));
        return Response.json({ candidates: [], testedCount: 100, hasMore: true, sequence: 1 });
      },
    }),
  };
  const response = await worker.fetch(
    new Request("https://example.test/api/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Jane Smith", context: "Acme" }),
    }),
    { ...secrets, SEARCH_RATE_LIMITER: allow, SEARCH_SESSIONS: sessions },
  );
  const body = await response.json() as { continuation: string };

  assert.equal(response.status, 200);
  assert.ok(body.continuation.length < 400);
  assert.deepEqual(internalBody, {
    input: { name: "Jane Smith", context: "Acme" },
    sequence: 0,
    initialize: true,
  });
});
