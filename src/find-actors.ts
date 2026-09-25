import { searchActorsPage, type BlueskyActor } from "./bluesky.js";
import {
  applyBioMatchStrategies,
  answerProbability,
  classifyContext,
  contextStrategyWeights,
  jevBioMatchStrategy,
  keywordBioMatchStrategy,
  type ContextInterpretation,
  type WeightedBioMatchStrategy,
} from "./bio-match.js";
import {
  analyzeName,
  type NameAnalysis,
} from "./name-match.js";

export { answerProbability };

export type FindActorsInput = {
  name: string;
  context?: string;
  contextInterpretation?: ContextInterpretation;
  nameAnalysis?: NameAnalysis;
};

export type FindActorsPage = {
  candidates: ActorResult[];
  scoredCandidates: ActorResult[];
  testedCount: number;
  hasMore: boolean;
  contextInterpretation?: ContextInterpretation;
  bioMatchWeights?: { keyword: number; jev: number };
  nameAnalysis?: NameAnalysis;
};

export type ActorResult = BlueskyActor & {
  profileUrl: string;
  nameScore: number;
  contextSupportScore?: number;
  contextContradictionScore?: number;
  bioMatchScores?: Record<string, {
    supportScore?: number;
    contradictionScore?: number;
  }>;
  matchScore: number;
};

export const BATCH_SIZE = 100;
export const MAX_RESULTS = 10;
export const MAX_CANDIDATES_PER_SEARCH = 100_000;
export const MAX_SEARCH_QUERIES = 8;

export type SearchState = {
  name: string;
  context: string;
  searches: Array<{ query: string; cursor?: string; exhausted?: boolean }>;
  contextInterpretation?: ContextInterpretation;
  nameAnalysis?: NameAnalysis;
};

export type SeenActors = {
  has(did: string): boolean;
  add(did: string): void;
  size(): number;
};

type JevResponse = {
  answers: Record<string, { type: "noul"; noul: number }>;
};

function bioMatchStrategies(
  interpretation: ContextInterpretation,
): readonly WeightedBioMatchStrategy[] {
  const weights = contextStrategyWeights(interpretation);
  return [
    { strategy: keywordBioMatchStrategy, weight: weights.keyword },
    { strategy: jevBioMatchStrategy, weight: weights.jev },
  ];
}

function nameQuestion(actor: BlueskyActor) {
  return {
    type: "noul",
    instructions: {
      candidate: {
        handle: actor.handle,
        displayName: actor.displayName ?? "",
      },
      question: "Could this handle or display name plausibly represent the supplied target name?",
    },
    criteria: {
      true: "The name clearly matches, including natural aliases, joined words, prefixes, suffixes, initials, nicknames, or a domain-style handle.",
      false: "The handle and display name appear unrelated to the target name.",
    },
  };
}

function effectiveName(input: FindActorsInput) {
  return input.nameAnalysis?.abbreviations.length
    ? `${input.name} ${input.nameAnalysis.abbreviations.join(" ")}`
    : input.name;
}

async function scoreCandidates(
  input: FindActorsInput,
  candidates: BlueskyActor[],
  apiKey: string,
  interpretation?: ContextInterpretation,
) {
  const context = input.context?.trim();

  const nameQuestions = Object.fromEntries(
    candidates.map((candidate, index) => [`name_${index}`, nameQuestion(candidate)]),
  );

  const [nameAnswers, bioMatches] = await Promise.all([
    askJev(apiKey, { targetName: effectiveName(input) }, nameQuestions),
    context
      ? applyBioMatchStrategies(
          bioMatchStrategies(interpretation ?? { keywordProbability: 0.5, freeTextProbability: 0.5 }),
          context,
          candidates,
          apiKey,
        )
      : Promise.resolve(undefined),
  ]);

  return candidates.map((candidate, index) => {
    const nameProbability = answerProbability(nameAnswers, `name_${index}`);
    const bioMatch = context ? bioMatches?.get(candidate.did) : undefined;
    const supportProbability = context
      ? bioMatch?.support ?? 0
      : undefined;
    const contradictionProbability = context
      ? bioMatch?.contradiction ?? 1
      : undefined;
    const probability = supportProbability === undefined
      ? nameProbability
      : Math.max(nameProbability, supportProbability)
        * (0.65 + 0.35 * Math.min(nameProbability, supportProbability))
        * (1 - 0.8 * (contradictionProbability ?? 0));
    return {
      ...candidate,
      profileUrl: `https://bsky.app/profile/${candidate.did}`,
      nameScore: toScore(nameProbability),
      contextSupportScore: supportProbability === undefined ? undefined : toScore(supportProbability),
      contextContradictionScore: contradictionProbability === undefined
        ? undefined
        : toScore(contradictionProbability),
      bioMatchScores: bioMatch
        ? Object.fromEntries(Object.entries(bioMatch.strategies).map(([name, scores]) => [name, {
            supportScore: scores.support === undefined ? undefined : toScore(scores.support),
            contradictionScore: scores.contradiction === undefined
              ? undefined
              : toScore(scores.contradiction),
          }]))
        : undefined,
      matchScore: toScore(probability),
    };
  }).sort((a, b) => b.matchScore - a.matchScore);
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

export function toScore(probability: number) {
  return Math.round(probability * 100) / 10;
}

export function createQueries(input: FindActorsInput) {
  const searchName = effectiveName(input);
  const nameParts = searchName.split(/\s+/).filter((part) => part.length >= 2);
  const queries = [
    searchName,
    ...nameParts,
  ]
    .map((query) => query?.trim())
    .filter((query): query is string => Boolean(query));
  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = query.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_SEARCH_QUERIES);
}

export function createSearchState(input: FindActorsInput): SearchState {
  return {
    name: input.name,
    context: input.context ?? "",
    searches: createQueries(input).map((query) => ({ query })),
    contextInterpretation: input.contextInterpretation,
    nameAnalysis: input.nameAnalysis,
  };
}

function applyNameAnalysis(state: SearchState, analysis?: NameAnalysis) {
  if (!analysis || state.nameAnalysis) return;
  state.nameAnalysis = analysis;
  state.searches = createQueries({ name: state.name, nameAnalysis: analysis }).map((query) => ({ query }));
}

async function nextCandidateBatch(state: SearchState, seen: SeenActors) {
  const candidates: BlueskyActor[] = [];
  const targetSize = Math.min(BATCH_SIZE, MAX_CANDIDATES_PER_SEARCH - seen.size());

  while (candidates.length < targetSize) {
    const active = state.searches
      .filter((search) => !search.exhausted)
      .slice(0, targetSize - candidates.length);
    if (!active.length) break;

    const remaining = targetSize - candidates.length;
    const baseLimit = Math.floor(remaining / active.length);
    const extra = remaining % active.length;
    const pages = await Promise.all(active.map((search, index) => searchActorsPage(
      search.query,
      baseLimit + (index < extra ? 1 : 0),
      search.cursor,
    )));

    pages.forEach((page, index) => {
      active[index].cursor = page.cursor;
      active[index].exhausted = !page.cursor || page.actors.length === 0;
    });

    for (let rank = 0; candidates.length < targetSize; rank += 1) {
      let foundAtRank = false;
      for (const page of pages) {
        const actor = page.actors[rank];
        if (!actor) continue;
        foundAtRank = true;
        if (seen.has(actor.did)) continue;
        seen.add(actor.did);
        candidates.push(actor);
        if (candidates.length === targetSize) break;
      }
      if (!foundAtRank) break;
    }

    if (pages.every((page) => page.actors.length === 0)) break;
  }

  return candidates;
}

/**
 * Fetches and scores one batch. Candidates always originate from public AT
 * Protocol search; Jev receives no mechanism to introduce handles or DIDs.
 */
export async function findActors(
  input: FindActorsInput,
  state: SearchState,
  seen: SeenActors,
  apiKey: string,
): Promise<FindActorsPage> {
  const context = input.context?.trim();
  let nameAnalysis = state.nameAnalysis ?? input.nameAnalysis;
  if (!nameAnalysis) {
    try {
      nameAnalysis = await analyzeName(input.name, apiKey);
    } catch (error) {
      // Name enrichment is additive; a Jev failure must not prevent the
      // authoritative Bluesky search from proceeding with base queries.
      console.error("What’s Their @? name analysis failed", error instanceof Error ? error.message : "unknown error");
      nameAnalysis = { name: input.name, abbreviations: [] };
    }
  }
  applyNameAnalysis(state, nameAnalysis);
  const [candidates, contextInterpretation] = await Promise.all([
    nextCandidateBatch(state, seen),
    context && !state.contextInterpretation
      ? classifyContext(context, apiKey)
      : Promise.resolve(state.contextInterpretation),
  ]);
  if (contextInterpretation) state.contextInterpretation = contextInterpretation;
  const hasMore = seen.size() < MAX_CANDIDATES_PER_SEARCH
    && state.searches.some((search) => !search.exhausted);

  const scoredCandidates = candidates.length
    ? await scoreCandidates(input, candidates, apiKey, contextInterpretation)
    : [];

  return {
    candidates: scoredCandidates.slice(0, MAX_RESULTS),
    scoredCandidates,
    testedCount: candidates.length,
    hasMore,
    contextInterpretation,
    bioMatchWeights: contextInterpretation
      ? contextStrategyWeights(contextInterpretation)
      : undefined,
    nameAnalysis: state.nameAnalysis,
  };
}
