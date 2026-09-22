import { CONTINUATION_TTL_MS } from "../src/continuation.js";
import {
  createSearchState,
  findActors,
  type FindActorsInput,
  type SeenActors,
  type SearchState,
} from "../src/find-actors.js";

const SESSION_KEY = "session";

export type StoredSearchSession = {
  input: FindActorsInput;
  search: SearchState;
  sequence: number;
  expiresAt: number;
};

type DurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
  sql: {
    exec<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { one(): T; toArray(): T[] };
  };
};

type DurableObjectState = {
  storage: DurableObjectStorage;
};

type SearchSessionEnv = {
  TYPESAFE_API_KEY: string;
};

type NextBatchRequest = {
  input: FindActorsInput;
  sequence: number;
  initialize: boolean;
};

export class InvalidSearchSessionError extends Error {
  constructor(readonly expired = false) {
    super(expired ? "Search session expired" : "Invalid search session");
    this.name = "InvalidSearchSessionError";
  }
}

function sameInput(left: FindActorsInput, right: FindActorsInput) {
  return left.name === right.name && (left.context ?? "") === (right.context ?? "");
}

/** Creates the small metadata record stored beside the SQLite seen-DID table. */
export function initializeSearchSession(input: FindActorsInput, now = Date.now()): StoredSearchSession {
  return {
    input,
    search: createSearchState(input),
    sequence: 0,
    expiresAt: now + CONTINUATION_TTL_MS,
  };
}

class SqlSeenActors implements SeenActors {
  private readonly pending = new Set<string>();

  constructor(private readonly sql: DurableObjectStorage["sql"]) {}

  has(did: string) {
    return this.pending.has(did)
      || this.sql.exec("SELECT did FROM seen_actors WHERE did = ? LIMIT 1", did).toArray().length > 0;
  }

  add(did: string) {
    this.pending.add(did);
  }

  size() {
    return Number(this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM seen_actors").one().count)
      + this.pending.size;
  }

  commit() {
    for (const did of this.pending) {
      this.sql.exec("INSERT OR IGNORE INTO seen_actors (did) VALUES (?)", did);
    }
    this.pending.clear();
  }
}

/**
 * Atomically advances the expected client sequence and slides idle expiry.
 * Callers persist this claim before beginning outbound provider work.
 */
export function claimSearchSession(
  session: StoredSearchSession,
  input: FindActorsInput,
  sequence: number,
  now = Date.now(),
) {
  if (session.expiresAt <= now) throw new InvalidSearchSessionError(true);
  if (!sameInput(session.input, input) || session.sequence !== sequence) {
    throw new InvalidSearchSessionError();
  }
  return {
    ...session,
    sequence: session.sequence + 1,
    expiresAt: now + CONTINUATION_TTL_MS,
  };
}

function isNextBatchRequest(value: unknown): value is NextBatchRequest {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<NextBatchRequest>;
  return typeof body.input === "object"
    && body.input !== null
    && typeof body.input.name === "string"
    && (body.input.context === undefined || typeof body.input.context === "string")
    && Number.isSafeInteger(body.sequence)
    && (body.sequence ?? -1) >= 0
    && typeof body.initialize === "boolean";
}

async function clearStorage(storage: DurableObjectStorage) {
  await storage.deleteAlarm();
  await storage.deleteAll();
}

/**
 * Owns ephemeral pagination state for one opaque session ID. Alarms recheck
 * idle expiry before deleting all KV and SQLite storage; completed searches
 * are cleared immediately.
 */
export class SearchSession {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: SearchSessionEnv,
  ) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS seen_actors (did TEXT PRIMARY KEY)");
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!isNextBatchRequest(body)) return Response.json({ error: "Invalid session request" }, { status: 400 });

    let session = await this.ctx.storage.get<StoredSearchSession>(SESSION_KEY);
    if (body.initialize) {
      if (session) return Response.json({ error: "Session already exists" }, { status: 409 });
      session = initializeSearchSession(body.input);
    } else if (!session) {
      return Response.json({ error: "Search session expired" }, { status: 410 });
    }

    try {
      session = claimSearchSession(session, body.input, body.sequence);
    } catch (error) {
      if (error instanceof InvalidSearchSessionError && error.expired) {
        await clearStorage(this.ctx.storage);
        return Response.json({ error: "Search session expired" }, { status: 410 });
      }
      return Response.json({ error: "Invalid search sequence" }, { status: 409 });
    }

    // Persist the sequence claim before outbound work so concurrent/replayed
    // requests cannot process the same continuation twice.
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(session.expiresAt);

    const seen = new SqlSeenActors(this.ctx.storage.sql);
    const searchBefore = structuredClone(session.search);
    let page;
    try {
      page = await findActors(
        session.input,
        session.search,
        seen,
        this.env.TYPESAFE_API_KEY,
      );
    } catch (error) {
      // Restore the claim so a transient upstream failure can retry with the
      // same client token. The persisted search state predates outbound work.
      await this.ctx.storage.put(SESSION_KEY, {
        ...session,
        search: searchBefore,
        sequence: body.sequence,
      });
      throw error;
    }
    seen.commit();
    if (!page.hasMore) {
      await clearStorage(this.ctx.storage);
    } else {
      await this.ctx.storage.put(SESSION_KEY, session);
      await this.ctx.storage.setAlarm(session.expiresAt);
    }

    return Response.json({
      candidates: page.candidates,
      testedCount: page.testedCount,
      hasMore: page.hasMore,
      sequence: session.sequence,
    });
  }

  async alarm() {
    const session = await this.ctx.storage.get<StoredSearchSession>(SESSION_KEY);
    if (session && session.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(session.expiresAt);
      return;
    }
    await clearStorage(this.ctx.storage);
  }
}
