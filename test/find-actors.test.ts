import assert from "node:assert/strict";
import test from "node:test";
import { answerProbability, createQueries, toScore } from "../src/find-actors.js";

test("builds deduplicated search queries from meaningful name parts", () => {
  assert.deepEqual(
    createQueries({ name: "Jo Ada Lovelace" }),
    ["Jo Ada Lovelace", "Jo", "Ada", "Lovelace"],
  );
});

test("searches the complete enriched name and each meaningful word", () => {
  assert.deepEqual(
    createQueries({ name: "Florian Lovelace", nameAnalysis: { name: "Florian Lovelace", abbreviations: ["flo", "lov"] } }),
    ["Florian Lovelace flo lov", "Florian", "Lovelace", "flo", "lov"],
  );
});

test("automatic and manually supplied enrichment produce the same query set", () => {
  assert.deepEqual(
    createQueries({ name: "Florian", nameAnalysis: { name: "Florian", abbreviations: ["flo"] } }),
    createQueries({ name: "Florian flo", nameAnalysis: { name: "Florian flo", abbreviations: [] } }),
  );
});

test("searches two-letter enrichments independently", () => {
  const expected = ["Rudy ru", "Rudy", "ru"];
  assert.deepEqual(
    createQueries({ name: "Rudy", nameAnalysis: { name: "Rudy", abbreviations: ["ru"] } }),
    expected,
  );
  assert.deepEqual(
    createQueries({ name: "Rudy ru", nameAnalysis: { name: "Rudy ru", abbreviations: [] } }),
    expected,
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
