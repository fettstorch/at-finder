import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBioMatchStrategies,
  contextStrategyWeights,
  keywordBioMatchStrategy,
  tokenizeContextTerms,
  type BioMatchStrategy,
} from "../src/bio-match.js";

test("context interpretation changes strategy emphasis without disabling either strategy", () => {
  assert.deepEqual(
    contextStrategyWeights({ keywordProbability: 1, freeTextProbability: 0 }),
    { keyword: 1, jev: 0.25 },
  );
  assert.deepEqual(
    contextStrategyWeights({ keywordProbability: 0, freeTextProbability: 1 }),
    { keyword: 0.25, jev: 1 },
  );
  assert.deepEqual(
    contextStrategyWeights({ keywordProbability: 0.5, freeTextProbability: 0.5 }),
    { keyword: 0.625, jev: 0.625 },
  );
});

const candidates = [
  { did: "did:example:one", handle: "one.test" },
  { did: "did:example:two", handle: "two.test" },
];

function strategy(name: string, results: Array<{ did: string; support: number; contradiction: number }>): BioMatchStrategy {
  return {
    name,
    async evaluate() {
      return results;
    },
  };
}

test("combines multiple bio strategies using normalized explicit weights", async () => {
  const matches = await applyBioMatchStrategies(
    [
      {
        strategy: strategy("supportive", [
          { did: candidates[0].did, support: 1, contradiction: 0 },
          { did: candidates[1].did, support: 0, contradiction: 1 },
        ]),
        weight: 3,
      },
      {
        strategy: strategy("contradictory", [
          { did: candidates[0].did, support: 0, contradiction: 1 },
          { did: candidates[1].did, support: 1, contradiction: 0 },
        ]),
        weight: 1,
      },
    ],
    "target context",
    candidates,
    "test-key",
  );

  assert.deepEqual(matches.get(candidates[0].did), {
    support: 0.75,
    contradiction: 0.25,
    strategies: {
      supportive: { support: 1, contradiction: 0 },
      contradictory: { support: 0, contradiction: 1 },
    },
  });
  assert.deepEqual(matches.get(candidates[1].did), {
    support: 0.25,
    contradiction: 0.75,
    strategies: {
      supportive: { support: 0, contradiction: 1 },
      contradictory: { support: 1, contradiction: 0 },
    },
  });
});

test("rejects invalid or misaligned strategy results before aggregation", async () => {
  const invalid = strategy("invalid", [
    { did: candidates[0].did, support: 0.5, contradiction: 0.5 },
    { did: "did:example:unknown", support: 0.5, contradiction: 0.5 },
  ]);

  await assert.rejects(
    applyBioMatchStrategies([{ strategy: invalid, weight: 1 }], "context", candidates, "test-key"),
    /misaligned results/,
  );

  const outOfRange = strategy("out-of-range", [
    { did: candidates[0].did, support: 1.1, contradiction: 0 },
    { did: candidates[1].did, support: 0, contradiction: 1 },
  ]);
  await assert.rejects(
    applyBioMatchStrategies([{ strategy: outOfRange, weight: 1 }], "context", candidates, "test-key"),
    /invalid support/,
  );
});

test("rejects duplicate strategy names so score breakdowns cannot be overwritten", async () => {
  const duplicate = strategy("duplicate", [
    { did: candidates[0].did, support: 1, contradiction: 0 },
    { did: candidates[1].did, support: 0, contradiction: 1 },
  ]);
  await assert.rejects(
    applyBioMatchStrategies(
      [{ strategy: duplicate, weight: 1 }, { strategy: duplicate, weight: 1 }],
      "context",
      candidates,
      "test-key",
    ),
    /names must be unique/,
  );
});

async function keywordMatch(context: string, description?: string) {
  const [match] = await keywordBioMatchStrategy.evaluate(
    context,
    [{ did: "did:example:keyword", handle: "keyword.test", description }],
    "unused",
  );
  return match;
}

test("tokenizes unique content terms while excluding conservative English stopwords", () => {
  assert.deepEqual(
    tokenizeContextTerms("She streams Minecraft on stream.place and ACME Acme München 42! 日本語 42"),
    ["streams", "minecraft", "stream", "place", "acme", "münchen", "42", "日本語"],
  );
  assert.deepEqual(tokenizeContextTerms("he she a the and on"), []);
  assert.deepEqual(tokenizeContextTerms("not only works without help"), ["not", "only", "works", "without", "help"]);
});

test("keyword bio matching supports exact, case-insensitive, and Unicode matches", async () => {
  assert.equal((await keywordMatch("artist poet", "Artist and poet")).support, 1);
  assert.equal((await keywordMatch("AcMe", "Working at ACME")).support, 1);
  assert.equal((await keywordMatch("München 日本語", "MÜNCHEN 日本語")).support, 1);
});

test("keyword bio matching ignores stopwords in its support denominator", async () => {
  assert.equal(
    (await keywordMatch("she streams Minecraft on stream.place", "Minecraft streamer at stream.place")).support,
    0.75,
  );
  assert.equal((await keywordMatch("she is an artist", "Artist")).support, 1);
});

test("keyword bio matching gives substring matches half credit", async () => {
  assert.equal((await keywordMatch("ice", "Ice cream")).support, 1);
  assert.equal((await keywordMatch("ice", "Nice person")).support, 0.5);
  assert.equal((await keywordMatch("void", "Maintainer of voidzero.dev")).support, 0.5);
  assert.equal((await keywordMatch("void engineer", "VoidZero engineer")).support, 0.75);
});

test("keyword bio matching treats partial and missing terms as support without contradiction", async () => {
  assert.deepEqual(await keywordMatch("artist writer", "Artist"), {
    did: "did:example:keyword",
    support: 0.5,
    contradiction: undefined,
  });
  assert.deepEqual(await keywordMatch("artist", "Engineer"), {
    did: "did:example:keyword",
    support: 0,
    contradiction: undefined,
  });
});

test("keyword bio matching treats an empty bio as fully contradictory", async () => {
  assert.deepEqual(await keywordMatch("artist", "   "), {
    did: "did:example:keyword",
    support: 0,
    contradiction: 1,
  });
});

test("keyword and another strategy aggregate at equal configured weight", async () => {
  const candidate = { did: "did:example:keyword", handle: "keyword.test", description: "voidzero.dev" };
  const matches = await applyBioMatchStrategies(
    [
      { strategy: keywordBioMatchStrategy, weight: 1 },
      {
        strategy: strategy("other", [{ did: candidate.did, support: 0, contradiction: 1 }]),
        weight: 1,
      },
    ],
    "void",
    [candidate],
    "unused",
  );
  assert.deepEqual(matches.get(candidate.did), {
    support: 0.25,
    contradiction: 1,
    strategies: {
      keyword: { support: 0.5, contradiction: undefined },
      other: { support: 0, contradiction: 1 },
    },
  });
});
