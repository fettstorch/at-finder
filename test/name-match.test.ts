import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeName,
  createNameAbbreviationProposals,
  deriveNamePrefix,
  NAME_ABBREVIATION_THRESHOLD,
  validateNameAnalysis,
} from "../src/name-match.js";

test("derives conservative first-syllable-like prefixes", () => {
  assert.equal(deriveNamePrefix("Florian"), "flo");
  assert.equal(deriveNamePrefix("Rudy"), "ru");
  assert.equal(deriveNamePrefix("Rude"), "ru");
  assert.equal(deriveNamePrefix("Alice"), undefined);
  assert.equal(deriveNamePrefix("flo"), undefined);
  assert.deepEqual(createNameAbbreviationProposals("Florian Lovelace"), [
    { word: "Florian", abbreviation: "flo" },
    { word: "Lovelace", abbreviation: "lo" },
  ]);
  assert.deepEqual(createNameAbbreviationProposals("Florian flo"), []);
});

test("validates that accepted abbreviations came from the name proposals", () => {
  assert.deepEqual(
    validateNameAnalysis({ name: "Florian", abbreviations: ["flo"] }, "Florian"),
    { name: "Florian", abbreviations: ["flo"] },
  );
  assert.throws(
    () => validateNameAnalysis({ name: "Florian", abbreviations: ["flori"] }, "Florian"),
    /invalid/,
  );
});

test("asks Jev about plausible handle prefixes and accepts at a recall-friendly threshold", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: { questions: Record<string, unknown> } | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    return Response.json({
      answers: {
        abbreviation_0: { type: "noul", noul: NAME_ABBREVIATION_THRESHOLD },
        abbreviation_1: { type: "noul", noul: NAME_ABBREVIATION_THRESHOLD - 0.01 },
      },
    });
  };

  try {
    assert.deepEqual(await analyzeName("Florian Lovelace", "test-key"), {
      name: "Florian Lovelace",
      abbreviations: ["flo"],
    });
    const firstQuestion = requestBody?.questions.abbreviation_0 as {
      instructions: { question: string };
      criteria: { true: string; false: string };
    };
    assert.match(firstQuestion.instructions.question, /plausibly appear in a handle or display name/);
    assert.match(firstQuestion.criteria.true, /recognizable prefix or first-syllable form/);
    assert.match(firstQuestion.criteria.true, /Florian -> flo/);
    assert.match(firstQuestion.criteria.false, /unrelated, arbitrary, or identity-destroying/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
