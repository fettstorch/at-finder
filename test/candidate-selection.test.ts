import assert from "node:assert/strict";
import test from "node:test";
import { CandidateSelection, isCandidateToggleKey } from "../web/candidate-selection.js";

type Candidate = { did: string; matchScore: number };
const candidate = (did: string, matchScore: number): Candidate => ({ did, matchScore });

test("locked candidates keep lock order above independently ranked results", () => {
  const selection = new CandidateSelection<Candidate>();
  selection.upsert([
    candidate("did:low", 2),
    candidate("did:high", 10),
    candidate("did:middle", 6),
    candidate("did:new", 8),
  ]);
  selection.toggle("did:middle");
  selection.toggle("did:low");

  assert.deepEqual(selection.view(2), {
    locked: [candidate("did:middle", 6), candidate("did:low", 2)],
    rotating: [candidate("did:high", 10), candidate("did:new", 8)],
  });
});

test("later batches cannot displace or reorder locked candidates", () => {
  const selection = new CandidateSelection<Candidate>();
  selection.upsert([candidate("did:first", 5), candidate("did:second", 4)]);
  selection.toggle("did:first");
  selection.toggle("did:second");
  selection.upsert([candidate("did:new-best", 10), candidate("did:first", 9)]);

  const view = selection.view(1);
  assert.deepEqual(view.locked.map(({ did }) => did), ["did:first", "did:second"]);
  assert.deepEqual(view.rotating.map(({ did }) => did), ["did:new-best"]);
});

test("unlock returns a candidate to ranking and reset clears all search state", () => {
  const selection = new CandidateSelection<Candidate>();
  selection.upsert([candidate("did:one", 8), candidate("did:two", 6)]);
  assert.equal(selection.toggle("did:one"), true);
  assert.equal(selection.toggle("did:one"), false);
  assert.deepEqual(selection.view().rotating.map(({ did }) => did), ["did:one", "did:two"]);

  selection.toggle("did:two");
  selection.reset();
  assert.deepEqual(selection.view(), { locked: [], rotating: [] });
  assert.equal(selection.size, 0);
});

test("card keyboard activation accepts Enter and Space only", () => {
  assert.equal(isCandidateToggleKey("Enter"), true);
  assert.equal(isCandidateToggleKey(" "), true);
  assert.equal(isCandidateToggleKey("Spacebar"), true);
  assert.equal(isCandidateToggleKey("Tab"), false);
  assert.equal(isCandidateToggleKey("ArrowDown"), false);
});
