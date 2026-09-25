export type NameAbbreviationProposal = {
  word: string;
  abbreviation: string;
};

export type NameAnalysis = {
  name: string;
  abbreviations: string[];
};

type JevResponse = {
  answers: Record<string, { type: "noul"; noul: number }>;
};

export const NAME_ABBREVIATION_THRESHOLD = 0.65;

function nameLetters(word: string) {
  return word.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
}

/**
 * Produces a deliberately short, code-generated candidate for Jev to judge.
 * The minimum source length and reduction guard keep already-short names such
 * as "flo" out of the enrichment pass.
 */
export function deriveNamePrefix(word: string): string | undefined {
  const letters = nameLetters(word);
  if (letters.length < 4) return undefined;

  const firstVowel = [...letters].findIndex((character) => /[aeiouy]/u.test(character));
  if (firstVowel <= 0) return undefined;
  const prefixLength = firstVowel + 1;
  if (prefixLength >= letters.length - 1 || prefixLength > Math.floor(letters.length * 0.6)) {
    return undefined;
  }
  return letters.slice(0, prefixLength);
}

export function createNameAbbreviationProposals(name: string): NameAbbreviationProposal[] {
  const words = name.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const inputWords = new Set(words.map(nameLetters));
  const seen = new Set<string>();
  return words.flatMap((word) => {
    const abbreviation = deriveNamePrefix(word);
    if (!abbreviation || inputWords.has(abbreviation) || seen.has(abbreviation)) return [];
    seen.add(abbreviation);
    return [{ word, abbreviation }];
  });
}

function answerProbability(body: JevResponse, key: string) {
  const probability = body.answers[key]?.noul;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`Jev returned an invalid answer for ${key}`);
  }
  return probability;
}

async function askJev(
  apiKey: string,
  state: Record<string, string>,
  questions: Record<string, unknown>,
) {
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Jev name analysis failed with ${response.status}`);
  return (await response.json()) as JevResponse;
}

/**
 * Jev may only accept one of the deterministic proposals above. It is never
 * asked to produce a handle, DID, name, or abbreviation of its own.
 */
export async function analyzeName(name: string, apiKey: string): Promise<NameAnalysis> {
  const proposals = createNameAbbreviationProposals(name);
  if (!proposals.length) return { name, abbreviations: [] };

  const questions = Object.fromEntries(proposals.map((proposal, index) => [`abbreviation_${index}`, {
    type: "noul",
    instructions: {
      nameWord: proposal.word,
      proposedAbbreviation: proposal.abbreviation,
      question: "Could this code-derived short prefix plausibly appear in a handle or display name for someone with the supplied name?",
    },
    criteria: {
      true: "Accept a recognizable prefix or first-syllable form of the supplied name word, such as Florian -> flo, when it could plausibly appear in that person's handle or display name.",
      false: "Reject a prefix that is unrelated, arbitrary, or identity-destroying and does not preserve a recognizable part of the supplied name word.",
    },
  }]));
  const body = await askJev(apiKey, { targetName: name }, questions);
  const abbreviations = proposals
    .filter((_proposal, index) => answerProbability(body, `abbreviation_${index}`) >= NAME_ABBREVIATION_THRESHOLD)
    .map((proposal) => proposal.abbreviation);
  return { name, abbreviations };
}

export function validateNameAnalysis(value: unknown, name: string): NameAnalysis {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Name analysis is invalid.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "name" && key !== "abbreviations")) {
    throw new Error("Name analysis is invalid.");
  }
  if (body.name !== name || !Array.isArray(body.abbreviations) || body.abbreviations.length > 32) {
    throw new Error("Name analysis is invalid.");
  }
  const allowed = new Set(createNameAbbreviationProposals(name).map((proposal) => proposal.abbreviation));
  const abbreviations = body.abbreviations;
  if (
    abbreviations.some((abbreviation) => typeof abbreviation !== "string" || !allowed.has(abbreviation))
    || new Set(abbreviations).size !== abbreviations.length
  ) throw new Error("Name analysis is invalid.");
  return { name, abbreviations: [...abbreviations] as string[] };
}
