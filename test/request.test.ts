import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BODY_BYTES, parseContextRequest, parseFindRequest, RequestError } from "../worker/request.js";

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

test("parses independent context requests and validated interpretations", async () => {
  assert.deepEqual(
    await parseContextRequest(request(JSON.stringify({ context: "  works at Lotum " }))),
    { context: "works at Lotum" },
  );
  assert.deepEqual(
    await parseFindRequest(request(JSON.stringify({
      name: "Florian",
      nameAnalysis: { name: "Florian", abbreviations: ["flo"] },
    }))),
    {
      name: "Florian",
      context: "",
      continuation: undefined,
      nameAnalysis: { name: "Florian", abbreviations: ["flo"] },
    },
  );
  assert.deepEqual(
    await parseFindRequest(request(JSON.stringify({
      name: "Jane",
      context: "Acme",
      contextInterpretation: { keywordProbability: 0.8, freeTextProbability: 0.2 },
    }))),
    {
      name: "Jane",
      context: "Acme",
      continuation: undefined,
      contextInterpretation: { keywordProbability: 0.8, freeTextProbability: 0.2 },
    },
  );
  await assert.rejects(
    parseFindRequest(request(JSON.stringify({
      name: "Jane",
      context: "Acme",
      contextInterpretation: { keywordProbability: 0.8, freeTextProbability: 0.8 },
    }))),
    /interpretation is invalid/,
  );
  await assert.rejects(
    parseFindRequest(request(JSON.stringify({
      name: "Florian",
      nameAnalysis: { name: "Florian", abbreviations: ["invented"] },
    }))),
    /Name analysis is invalid/,
  );
});

test("parses a strict name-analysis request", async () => {
  const { parseNameRequest } = await import("../worker/request.js");
  assert.deepEqual(await parseNameRequest(request(JSON.stringify({ name: " Florian " }))), { name: "Florian" });
  await assert.rejects(parseNameRequest(request(JSON.stringify({ name: "Florian", context: "Acme" }))), /unsupported fields/);
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
