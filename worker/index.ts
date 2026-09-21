import { findActors } from "../src/find-actors.js";

type Env = {
  TYPESAFE_API_KEY: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/find") return new Response(null, { status: 404 });
    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const context = typeof body?.context === "string" ? body.context.trim() : "";
    const continuation = typeof body?.continuation === "string" ? body.continuation : undefined;

    if (!name || name.length > 200 || context.length > 1_000) {
      return Response.json(
        { error: "Provide a name (max 200 characters) and optional context." },
        { status: 400 },
      );
    }
    if (!env.TYPESAFE_API_KEY) {
      return Response.json({ error: "TYPESAFE_API_KEY is missing." }, { status: 500 });
    }

    try {
      const page = await findActors({ name, context }, env.TYPESAFE_API_KEY, continuation);
      return Response.json({ query: { name, context }, ...page });
    } catch (error) {
      console.error(error);
      return Response.json({ error: "Could not search AT Protocol right now." }, { status: 502 });
    }
  },
};
