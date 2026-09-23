import assert from "node:assert/strict";
import test from "node:test";
import {
  createContinuation,
  InvalidContinuationError,
  readContinuation,
} from "../src/continuation.js";

const secret = "test-secret-that-is-at-least-thirty-two-characters";
const input = { name: "Jane Smith", context: "Acme" };
const claims = { sessionId: "123e4567-e89b-12d3-a456-426614174000", sequence: 7 };

test("continuation tokens round-trip only an opaque session reference", async () => {
  const token = await createContinuation(claims, input, secret, 1_000_000, 60_000);
  assert.deepEqual(await readContinuation(token, input, secret, 1_030_000), claims);
  assert.ok(token.length < 400);
  assert.doesNotMatch(token, /Jane|Acme/);
});

test("continuation token size stays bounded independently of server-side state", async () => {
  const largeContext = "x".repeat(1_000);
  const largeServerState = Array.from({ length: 100_000 }, (_, index) => `did:plc:${index}`);
  const shortToken = await createContinuation(claims, input, secret, 1_000_000);
  const largeInputToken = await createContinuation(
    claims,
    { name: input.name, context: largeContext },
    secret,
    1_000_000,
  );

  assert.ok(JSON.stringify(largeServerState).length > 1_000_000);
  assert.equal(largeInputToken.length, shortToken.length);
  assert.ok(shortToken.length < 400);
});

test("continuation tokens reject tampering, expiry, and different input", async () => {
  const token = await createContinuation(claims, input, secret, 1_000_000, 60_000);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

  await assert.rejects(readContinuation(tampered, input, secret, 1_030_000), InvalidContinuationError);
  await assert.rejects(readContinuation(token, input, secret, 1_060_000), InvalidContinuationError);
  await assert.rejects(
    readContinuation(token, { ...input, context: "Different" }, secret, 1_030_000),
    InvalidContinuationError,
  );
});
