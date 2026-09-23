import { createContinuation, InvalidContinuationError, readContinuation } from "../src/continuation.js";
import { classifyContext, contextStrategyWeights } from "../src/bio-match.js";
import { parseContextRequest, parseFindRequest, RequestError } from "./request.js";
export { SearchSession } from "./search-session.js";

type RateLimit = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type DurableObjectStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
};

type Env = {
  TYPESAFE_API_KEY: string;
  CONTINUATION_SECRET: string;
  SEARCH_RATE_LIMITER: RateLimit;
  SEARCH_SESSIONS: DurableObjectNamespace;
};

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function rateLimitKey(request: Request) {
  const ip = request.headers.get("cf-connecting-ip");
  return ip ? `ip:${ip}` : "anonymous";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/find" && url.pathname !== "/api/context") {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "POST") {
      return json(
        { error: "Method not allowed" },
        405,
        { Allow: "POST" },
      );
    }

    if (url.pathname === "/api/context") {
      let input: Awaited<ReturnType<typeof parseContextRequest>>;
      try {
        input = await parseContextRequest(request);
      } catch (error) {
        if (error instanceof RequestError) return json({ error: error.message }, error.status);
        return json({ error: "Request body could not be read." }, 400);
      }
      if (!env.TYPESAFE_API_KEY) return json({ error: "Service is not configured." }, 503);
      const allowed = await env.SEARCH_RATE_LIMITER.limit({ key: rateLimitKey(request) });
      if (!allowed.success) return json({ error: "Too many searches. Please wait before trying again." }, 429);
      try {
        const contextInterpretation = await classifyContext(input.context, env.TYPESAFE_API_KEY);
        return json({
          context: input.context,
          contextInterpretation,
          bioMatchWeights: contextStrategyWeights(contextInterpretation),
        });
      } catch (error) {
        console.error("AT Finder context analysis failed", error instanceof Error ? error.message : "unknown error");
        return json({ error: "Could not analyze context right now." }, 502);
      }
    }

    let input: Awaited<ReturnType<typeof parseFindRequest>>;
    try {
      input = await parseFindRequest(request);
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status);
      return json({ error: "Request body could not be read." }, 400);
    }
    if (!env.TYPESAFE_API_KEY || !env.CONTINUATION_SECRET) {
      console.error("Required Worker secrets are not configured");
      return json({ error: "Service is not configured." }, 503);
    }

    const allowed = await env.SEARCH_RATE_LIMITER.limit({ key: rateLimitKey(request) });
    if (!allowed.success) {
      return json(
        { error: "Too many searches. Please wait before trying again." },
        429,
        { "retry-after": "60" },
      );
    }

    try {
      const normalizedInput = { name: input.name, context: input.context };
      const sessionInput = { ...normalizedInput, contextInterpretation: input.contextInterpretation };
      const claims = input.continuation
        ? await readContinuation(input.continuation, normalizedInput, env.CONTINUATION_SECRET)
        : { sessionId: crypto.randomUUID(), sequence: 0 };
      const session = env.SEARCH_SESSIONS.get(env.SEARCH_SESSIONS.idFromName(claims.sessionId));
      const sessionResponse = await session.fetch("https://search-session.internal/next", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: sessionInput,
          sequence: claims.sequence,
          initialize: !input.continuation,
        }),
      });
      if (!sessionResponse.ok) {
        if (sessionResponse.status === 409 || sessionResponse.status === 410) {
          throw new InvalidContinuationError();
        }
        throw new Error(`Search session failed with ${sessionResponse.status}`);
      }
      const page = await sessionResponse.json() as {
        candidates: unknown[];
        debugCandidates?: unknown[];
        testedCount: number;
        hasMore: boolean;
        contextInterpretation?: { keywordProbability: number; freeTextProbability: number };
        bioMatchWeights?: { keyword: number; jev: number };
        sequence: number;
      };
      const continuation = page.hasMore
        ? await createContinuation(
            { sessionId: claims.sessionId, sequence: page.sequence },
            normalizedInput,
            env.CONTINUATION_SECRET,
          )
        : undefined;
      return json({
        query: normalizedInput,
        candidates: page.candidates,
        ...(import.meta.env?.DEV ? { debugCandidates: page.debugCandidates ?? [] } : {}),
        testedCount: page.testedCount,
        contextInterpretation: page.contextInterpretation,
        bioMatchWeights: page.bioMatchWeights,
        continuation,
      });
    } catch (error) {
      if (error instanceof InvalidContinuationError) {
        return json({ error: "Continuation token is invalid or expired." }, 400);
      }
      console.error("AT Finder search failed", error instanceof Error ? error.message : "unknown error");
      return json({ error: "Could not search AT Protocol right now." }, 502);
    }
  },
};
