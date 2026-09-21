export type BlueskyActor = {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  followersCount?: number;
};

export async function searchActorsPage(query: string, limit: number, cursor?: string) {
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(100, limit)));
  if (cursor) url.searchParams.set("cursor", cursor);

  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`AT Protocol actor search failed with ${response.status}`);
  return (await response.json()) as { actors: BlueskyActor[]; cursor?: string };
}
