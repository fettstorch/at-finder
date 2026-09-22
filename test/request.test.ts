import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BODY_BYTES, parseFindRequest, RequestError } from "../worker/request.js";

function request(body: string, contentType = "application/json") {
  return new Request("https://example.test/api/find", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

test("parses and trims a valid search request", async () => {
  assert.deepEqual(
    await parseFindRequest(request(JSON.stringify({ name: "  Jane Smith ", context: " Acme " }))),
    { name: "Jane Smith", context: "Acme", continuation: undefined },
  );
});

test("requires JSON and rejects unknown fields", async () => {
  await assert.rejects(parseFindRequest(request("{}", "text/plain")), (error: unknown) => (
    error instanceof RequestError && error.status === 415
  ));
  await assert.rejects(
    parseFindRequest(request(JSON.stringify({ name: "Jane", admin: true }))),
    /unsupported fields/,
  );
});

test("rejects malformed, invalid, and oversized bodies", async () => {
  await assert.rejects(parseFindRequest(request("{")), /valid JSON/);
  await assert.rejects(parseFindRequest(request(JSON.stringify({ name: "\u0000Jane" }))), /valid name/);
  await assert.rejects(
    parseFindRequest(request(JSON.stringify({ name: "Jane", context: "x".repeat(1_001) }))),
    /at most 1000/,
  );
  await assert.rejects(
    parseFindRequest(request("x".repeat(MAX_BODY_BYTES + 1))),
    (error: unknown) => error instanceof RequestError && error.status === 413,
  );
});
