import assert from "node:assert/strict";
import test from "node:test";
import { answerProbability, createQueries, toScore } from "../src/find-actors.js";

test("builds deduplicated search queries from meaningful name parts", () => {
  assert.deepEqual(
    createQueries({ name: "Jo Ada Lovelace" }),
    ["Jo Ada Lovelace", "AdaLovelace", "Ada", "Lovelace"],
  );
});

test("converts probabilities to the displayed ten-point score", () => {
  assert.equal(toScore(0.876), 8.8);
});

test("rejects missing or out-of-range model answers", () => {
  assert.equal(answerProbability({ answers: { score: { type: "noul", noul: 0.42 } } }, "score"), 0.42);
  assert.throws(() => answerProbability({ answers: {} }, "score"), /invalid answer/);
  assert.throws(
    () => answerProbability({ answers: { score: { type: "noul", noul: 1.1 } } }, "score"),
    /invalid answer/,
  );
});
