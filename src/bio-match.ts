import type { BlueskyActor } from "./bluesky.js";
import { tokenizeEnglishKeywords, tokenizeTerms } from "./english-stopwords.js";

export type BioMatchResult = {
  did: string;
  support?: number;
  contradiction?: number;
};

/** A strategy evaluates the complete candidate batch in one provider pass. */
export type BioMatchStrategy = {
  name: string;
  evaluate(
    context: string,
    candidates: readonly BlueskyActor[],
    apiKey: string,
  ): Promise<readonly BioMatchResult[]>;
};

export type WeightedBioMatchStrategy = {
  strategy: BioMatchStrategy;
  weight: number;
};

export type ContextInterpretation = {
  keywordProbability: number;
  freeTextProbability: number;
};

export function contextStrategyWeights(interpretation: ContextInterpretation) {
  return {
    keyword: 0.25 + 0.75 * interpretation.keywordProbability,
    jev: 0.25 + 0.75 * interpretation.freeTextProbability,
  };
}

export type AggregatedBioMatch = {
  support: number;
  contradiction: number;
  strategies: Record<string, {
    support?: number;
    contradiction?: number;
  }>;
};

export const tokenizeContextTerms = tokenizeEnglishKeywords;

function keywordTermScore(term: string, bio: string, bioTerms: ReadonlySet<string>) {
  if (bioTerms.has(term)) return 1;
  return bio.includes(term) ? 0.5 : 0;
}

class BioMatchStrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BioMatchStrategyError";
  }
}

function assertProbability(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BioMatchStrategyError(`Bio match strategy returned an invalid ${label}`);
  }
  return value;
}

function validateResults(
  strategy: BioMatchStrategy,
  candidates: readonly BlueskyActor[],
  results: readonly BioMatchResult[],
) {
  if (!Array.isArray(results)) {
    throw new BioMatchStrategyError(`Bio match strategy ${strategy.name} returned invalid results`);
  }
  if (results.length !== candidates.length) {
    throw new BioMatchStrategyError(
      `Bio match strategy ${strategy.name} returned ${results.length} results for ${candidates.length} candidates`,
    );
  }

  const expected = new Set(candidates.map((candidate) => candidate.did));
  const seen = new Set<string>();
  for (const result of results) {
    if (
      typeof result !== "object"
      || result === null
      || typeof result.did !== "string"
      || !expected.has(result.did)
      || seen.has(result.did)
    ) {
      throw new BioMatchStrategyError(`Bio match strategy ${strategy.name} returned misaligned results`);
    }
    if (result.support === undefined && result.contradiction === undefined) {
      throw new BioMatchStrategyError(`Bio match strategy ${strategy.name} returned no signals`);
    }
    if (result.support !== undefined) assertProbability(result.support, "support");
    if (result.contradiction !== undefined) assertProbability(result.contradiction, "contradiction");
    seen.add(result.did);
  }
  if (seen.size !== expected.size) {
    throw new BioMatchStrategyError(`Bio match strategy ${strategy.name} returned misaligned results`);
  }
}

/**
 * Evaluates configured strategies and combines their normalized signals. A
 * strategy result is keyed by DID so provider ordering cannot affect scoring.
 */
export async function applyBioMatchStrategies(
  configured: readonly WeightedBioMatchStrategy[],
  context: string,
  candidates: readonly BlueskyActor[],
  apiKey: string,
): Promise<ReadonlyMap<string, AggregatedBioMatch>> {
  const entries = configured.map(({ strategy, weight }) => {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new BioMatchStrategyError(`Bio match strategy ${strategy.name} has an invalid weight`);
    }
    return { strategy, weight };
  });
  if (new Set(entries.map(({ strategy }) => strategy.name)).size !== entries.length) {
    throw new BioMatchStrategyError("Bio match strategy names must be unique");
  }
  const evaluated = await Promise.all(entries.map(async ({ strategy, weight }) => ({
    weight,
    strategy,
    results: await strategy.evaluate(context, candidates, apiKey),
  })));
  const aggregated = new Map<string, AggregatedBioMatch>();
  for (const candidate of candidates) {
    aggregated.set(candidate.did, { support: 0, contradiction: 0, strategies: {} });
  }

  for (const { strategy, results } of evaluated) {
    validateResults(strategy, candidates, results);
    for (const result of results) {
      const current = aggregated.get(result.did);
      // validateResults guarantees that every result is for a candidate.
      if (!current) throw new BioMatchStrategyError("Bio match strategy returned an unknown candidate");
      current.strategies[strategy.name] = {
        support: result.support,
        contradiction: result.contradiction,
      };
    }
  }

  for (const candidate of candidates) {
    const current = aggregated.get(candidate.did)!;
    let supportWeight = 0;
    let contradictionWeight = 0;
    for (const { strategy, weight } of entries) {
      const result = current.strategies[strategy.name];
      if (result.support !== undefined) {
        current.support += result.support * weight;
        supportWeight += weight;
      }
      if (result.contradiction !== undefined) {
        current.contradiction += result.contradiction * weight;
        contradictionWeight += weight;
      }
    }
    if (supportWeight) current.support /= supportWeight;
    if (contradictionWeight) current.contradiction /= contradictionWeight;
  }

  return aggregated;
}

type JevResponse = {
  answers: Record<string, { type: "noul"; noul: number }>;
};

function contextSupportQuestion(actor: BlueskyActor) {
  return {
    type: "noul",
    instructions: {
      contextFormat: "The supplied target context may be one or more keywords or free text describing the person.",
      candidate: {
        bio: actor.description ?? "",
      },
      question: "Does this profile bio provide strong evidence supporting the supplied target context?",
    },
    criteria: {
      true: "The bio contains useful evidence for the target context, including direct words, compounds, domains, handles, aliases, roles, employers, projects, topics, locations, or past affiliations.",
      false: "The bio lacks strong supporting evidence or only matches a broad generic term.",
    },
  };
}

function contextMismatchQuestion(actor: BlueskyActor) {
  return {
    type: "noul",
    instructions: {
      contextFormat: "The supplied target context may be one or more keywords or free text describing the person.",
      candidate: {
        bio: actor.description ?? "",
      },
      question: "Does this profile bio fail to match the supplied target context?",
    },
    criteria: {
      true: "The bio lacks meaningful evidence for the target context, contains incompatible evidence, or clearly identifies a different person.",
      false: "The bio contains direct or semantically plausible evidence supporting the context, including compounds, domains, handles, aliases, roles, employers, projects, topics, locations, or past affiliations.",
    },
  };
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
    body: JSON.stringify({
      model: "jev-latest",
      state,
      questions,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`Jev scoring failed with ${response.status}`);
  return (await response.json()) as JevResponse;
}

export function answerProbability(body: JevResponse, key: string) {
  const probability = body.answers[key]?.noul;
  if (typeof probability !== "number" || probability < 0 || probability > 1) {
    throw new Error(`Jev returned an invalid answer for ${key}`);
  }
  return probability;
}

export async function classifyContext(
  context: string,
  apiKey: string,
): Promise<ContextInterpretation> {
  const body = await askJev(apiKey, { targetContext: context }, {
    keyword_collection: {
      type: "noul",
      instructions: {
        question: "Is the supplied target context a collection of search keywords rather than a description of the target person? Treat a short predicate or verb phrase as a description even when the implied subject ('they' or the person's name) is omitted.",
      },
      criteria: {
        true: "The input is merely one or more names, organizations, roles, technologies, topics, locations, or other search terms. It does not assert an action, attribute, relationship, history, preference, or other fact about the target person. Bare terms such as 'Void', 'Minecraft', 'pottery', or 'Void Zero Nuxt' are keywords.",
        false: "The input makes a natural-language claim about the person, including a short verb phrase with an omitted subject. Examples include 'streams Minecraft', 'does pottery', 'works at Lotum', and 'I think they work in web technology'. Length alone is not evidence for keywords.",
      },
    },
  });
  const keywordProbability = answerProbability(body, "keyword_collection");
  return { keywordProbability, freeTextProbability: 1 - keywordProbability };
}

/** The existing provider-backed bio strategy. */
export const jevBioMatchStrategy: BioMatchStrategy = {
  name: "jev",
  async evaluate(context, candidates, apiKey) {
    const questions = Object.fromEntries(
      candidates.flatMap((candidate, index) => candidate.description?.trim() ? [
        [`support_${index}`, contextSupportQuestion(candidate)],
        [`contradiction_${index}`, contextMismatchQuestion(candidate)],
      ] : []),
    );
    const body = Object.keys(questions).length
      ? await askJev(apiKey, { targetContext: context }, questions)
      : { answers: {} } as JevResponse;

    return candidates.map((candidate, index) => {
      const hasBio = Boolean(candidate.description?.trim());
      return {
        did: candidate.did,
        support: hasBio ? answerProbability(body, `support_${index}`) : 0,
        contradiction: hasBio ? answerProbability(body, `contradiction_${index}`) : 1,
      };
    });
  },
};

/** Matches each unique context term as a case-insensitive bio substring. */
export const keywordBioMatchStrategy: BioMatchStrategy = {
  name: "keyword",
  async evaluate(context, candidates) {
    const terms = tokenizeContextTerms(context);
    return candidates.map((candidate) => {
      const bio = candidate.description?.trim();
      const normalizedBio = bio?.toLowerCase() ?? "";
      const bioTerms = new Set(tokenizeTerms(normalizedBio));
      const support = bio && terms.length
        ? terms.reduce(
            (total, term) => total + keywordTermScore(term, normalizedBio, bioTerms),
            0,
          ) / terms.length
        : 0;
      return {
        did: candidate.did,
        support,
        contradiction: bio ? undefined : 1,
      };
    });
  },
};
