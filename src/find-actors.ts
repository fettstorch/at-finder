import { searchActorsPage, type BlueskyActor } from "./bluesky.js";

export type FindActorsInput = { name: string; context?: string };

export type FindActorsPage = {
  candidates: ActorResult[];
  testedCount: number;
  continuation?: string;
};

export type ActorResult = BlueskyActor & {
  profileUrl: string;
  nameScore: number;
  contextSupportScore?: number;
  contextContradictionScore?: number;
  matchScore: number;
};

const BATCH_SIZE = 100;
const MAX_RESULTS = 10;

type SearchState = {
  name: string;
  context: string;
  searches: Array<{ query: string; cursor?: string; exhausted?: boolean }>;
  seen: string[];
};

type JevResponse = {
  answers: Record<string, { type: "noul"; noul: number }>;
};

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

function contextSupportQuestion(actor: BlueskyActor) {
  return {
    type: "noul",
    instructions: {
      candidate: {
        bio: actor.description ?? "",
      },
      question: "Does this profile bio provide strong evidence supporting the supplied target context?",
    },
    criteria: {
      true: "The bio contains strong, useful evidence for the target context.",
      false: "The bio lacks strong supporting evidence or only matches a broad generic term.",
    },
  };
}

function contextContradictionQuestion(actor: BlueskyActor) {
  return {
    type: "noul",
    instructions: {
      candidate: {
        bio: actor.description ?? "",
      },
      question: "Does this profile bio contradict the supplied target context?",
    },
    criteria: {
      true: "The bio contains clear evidence that this is a different person or conflicts with the target context.",
      false: "The bio is compatible with the target context, merely lacks evidence, or is empty.",
    },
  };
}

async function scoreCandidates(
  input: FindActorsInput,
  candidates: BlueskyActor[],
  apiKey: string,
) {
  const context = input.context?.trim();

  const nameQuestions = Object.fromEntries(
    candidates.map((candidate, index) => [`name_${index}`, nameQuestion(candidate)]),
  );
  const contextQuestions = Object.fromEntries(
    candidates.flatMap((candidate, index) => context && candidate.description?.trim() ? [
      [`support_${index}`, contextSupportQuestion(candidate)],
      [`contradiction_${index}`, contextContradictionQuestion(candidate)],
    ] : []),
  );

  const [nameAnswers, contextAnswers] = await Promise.all([
    askJev(apiKey, { targetName: input.name }, nameQuestions),
    context && Object.keys(contextQuestions).length
      ? askJev(apiKey, { targetContext: context }, contextQuestions)
      : Promise.resolve({ answers: {} } as JevResponse),
  ]);

  const body: JevResponse = {
    answers: { ...nameAnswers.answers, ...contextAnswers.answers },
  };

  return candidates.map((candidate, index) => {
    const nameProbability = answerProbability(body, `name_${index}`);
    const hasBio = Boolean(candidate.description?.trim());
    const supportProbability = context && hasBio
      ? answerProbability(body, `support_${index}`)
      : context ? 0 : undefined;
    const contradictionProbability = context && hasBio
      ? answerProbability(body, `contradiction_${index}`)
      : context ? 1 : undefined;
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
      matchScore: toScore(probability),
    };
  }).sort((a, b) => b.matchScore - a.matchScore).slice(0, MAX_RESULTS);
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

function answerProbability(body: JevResponse, key: string) {
  const probability = body.answers[key]?.noul;
  if (typeof probability !== "number" || probability < 0 || probability > 1) {
    throw new Error(`Jev returned an invalid answer for ${key}`);
  }
  return probability;
}

function toScore(probability: number) {
  return Math.round(probability * 100) / 10;
}

function createQueries(input: FindActorsInput) {
  const nameParts = input.name.split(/\s+/).filter((part) => part.length >= 3);
  const compactName = nameParts.join("");
  return [...new Set(
    [
      input.name,
      compactName,
      ...nameParts,
    ]
      .map((query) => query?.trim())
      .filter((query): query is string => Boolean(query)),
  )];
}

function encodeState(state: SearchState) {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeState(token: string, input: FindActorsInput): SearchState {
  try {
    const state = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as SearchState;
    if (
      state.name !== input.name
      || state.context !== (input.context ?? "")
      || !Array.isArray(state.searches)
      || !Array.isArray(state.seen)
    ) throw new Error();
    return state;
  } catch {
    throw new Error("Invalid continuation token");
  }
}

async function nextCandidateBatch(state: SearchState) {
  const candidates: BlueskyActor[] = [];
  const seen = new Set(state.seen);

  while (candidates.length < BATCH_SIZE) {
    const active = state.searches
      .filter((search) => !search.exhausted)
      .slice(0, BATCH_SIZE - candidates.length);
    if (!active.length) break;

    const remaining = BATCH_SIZE - candidates.length;
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

    for (let rank = 0; candidates.length < BATCH_SIZE; rank += 1) {
      let foundAtRank = false;
      for (const page of pages) {
        const actor = page.actors[rank];
        if (!actor) continue;
        foundAtRank = true;
        if (seen.has(actor.did)) continue;
        seen.add(actor.did);
        candidates.push(actor);
        if (candidates.length === BATCH_SIZE) break;
      }
      if (!foundAtRank) break;
    }

    if (pages.every((page) => page.actors.length === 0)) break;
  }

  state.seen = [...seen];
  return candidates;
}

export async function findActors(
  input: FindActorsInput,
  apiKey: string,
  continuation?: string,
): Promise<FindActorsPage> {
  const state: SearchState = continuation
    ? decodeState(continuation, input)
    : {
        name: input.name,
        context: input.context ?? "",
        searches: createQueries(input).map((query) => ({ query })),
        seen: [],
      };

  const candidates = await nextCandidateBatch(state);
  const hasMore = state.searches.some((search) => !search.exhausted);

  return {
    candidates: candidates.length ? await scoreCandidates(input, candidates, apiKey) : [],
    testedCount: candidates.length,
    continuation: hasMore ? encodeState(state) : undefined,
  };
}
