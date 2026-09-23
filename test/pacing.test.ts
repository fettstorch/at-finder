import assert from "node:assert/strict";
import test from "node:test";
import { nextBatchDelay } from "../web/pacing.js";

test("uses the agreed progressive batch pacing landmarks", () => {
  const landmarks = [
    [0, 1],
    [2_000, 1],
    [5_000, 1.2],
    [10_000, 2.6],
    [20_000, 9.3],
    [30_000, 21.1],
    [40_000, 38],
    [50_000, 60],
    [100_000, 60],
  ] as const;

  for (const [tested, approximateSeconds] of landmarks) {
    assert.ok(
      Math.abs(nextBatchDelay(tested) / 1_000 - approximateSeconds) < 0.06,
      `${tested} candidates should wait about ${approximateSeconds} seconds`,
    );
  }
});
