export type BlueskyActor = {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  followersCount?: number;
};

function isActor(value: unknown): value is BlueskyActor {
  if (typeof value !== "object" || value === null) return false;
  const actor = value as Partial<BlueskyActor>;
  return typeof actor.did === "string"
    && actor.did.startsWith("did:")
    && actor.did.length <= 2_048
    && typeof actor.handle === "string"
    && actor.handle.length > 0
    && actor.handle.length <= 253
    && (actor.displayName === undefined || (typeof actor.displayName === "string" && actor.displayName.length <= 640))
    && (actor.description === undefined || (typeof actor.description === "string" && actor.description.length <= 10_000))
    && (actor.avatar === undefined || (typeof actor.avatar === "string" && actor.avatar.length <= 2_048))
    && (actor.followersCount === undefined || typeof actor.followersCount === "number");
}

export async function searchActorsPage(query: string, limit: number, cursor?: string) {
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(100, limit)));
  if (cursor) url.searchParams.set("cursor", cursor);

  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`AT Protocol actor search failed with ${response.status}`);
  const body = await response.json() as { actors?: unknown; cursor?: unknown };
  if (
    !Array.isArray(body.actors)
    || !body.actors.every(isActor)
    || (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 4_096))
  ) throw new Error("AT Protocol actor search returned an invalid response");
  return { actors: body.actors, cursor: body.cursor };
}
