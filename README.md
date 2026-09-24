# What’s Their @?

What’s Their @? is a small public website for finding likely AT Protocol accounts from a person's name and optional context. It searches real public actor profiles and uses a bounded Jev scoring pass to rerank only those observed candidates. The model cannot add accounts, handles, or DIDs to the result set.

## How it works

The browser sends a name, optional context, and later a small signed continuation token to `POST /api/find`. One Cloudflare Worker:

1. validates and rate-limits the request;
2. routes the search to a per-session Cloudflare Durable Object;
3. queries the public AT Protocol actor-search endpoint with name-derived queries;
4. asks Jev to score observed candidates for name similarity, context support, and contradiction;
5. returns up to ten results, including a score breakdown and a short-lived continuation token.

The Durable Object stores normalized input, public-search cursors, exhausted queries, seen DIDs, and the next allowed sequence number. The browser token contains only a random session ID, sequence, expiry, input digest, and signature; its size does not grow with the search. Exact sequencing rejects replayed or concurrent use of the same continuation.

The Vite client automatically requests later pages, merges candidates by DID, and preserves the ten strongest unlocked matches found so far. Visitors can lock any candidate into a stable, lock-ordered section while the unlocked ranking continues to rotate. Requests start one second apart through 2,000 tested candidates, then progressively slow to a maximum delay of one minute at 50,000 candidates. A 100,000-candidate server-side ceiling remains as a high-cost/storage safety boundary rather than a token-size workaround; normal searches should exhaust the public index first.

## Local development

Requirements: Node.js 24 and npm.

```sh
npm install
cp .env.example .env.local
npm run local
```

Set both values in `.env.local`:

- `TYPESAFE_API_KEY`: a Jev/System One API key.
- `CONTINUATION_SECRET`: at least 32 random characters used only to sign continuation references. Generate it with a cryptographically secure password or secret generator; do not commit or reuse it.

`npm run local` starts Vite with the API in the Cloudflare Workers runtime. AT Protocol profile search itself does not require a key.

The Cloudflare Vite plugin provides a local Durable Object implementation and persists its development state under the ignored `.wrangler/` directory. Production state is separate and is only created by deployment.

```sh
curl -X POST http://localhost:5173/api/find \
  -H 'content-type: application/json' \
  -d '{"name":"Jane Smith","context":"CEO of Acme"}'
```

The exact local port is printed by Vite.

## Scripts

- `npm run local` / `npm run dev`: run the site and Worker locally.
- `npm test`: run focused tests for continuation integrity, Durable Object lifecycle/sequencing, pacing, input boundaries, and scoring helpers.
- `npm run typecheck`: type-check all application code.
- `npm run build`: create production static assets in `dist/`.
- `npm run check`: run tests, type-checking, and the production build.
- `npm run deploy`: build and deploy through Wrangler. This is intentionally never run by CI.

Pull requests and pushes to `main` run `npm run check` in GitHub Actions.

`dist/` is ignored and must not be published as a generic build artifact: the Cloudflare Vite plugin can place local development variables in its generated Worker subdirectory. Deploy through the reviewed Wrangler workflow instead.

## Production deployment

Before the first deployment:

1. Create or select the intended Cloudflare account and authenticate Wrangler.
2. Review the `SEARCH_RATE_LIMITER` entry in `wrangler.jsonc`. Its numeric namespace ID must be unique within that Cloudflare account; change it if the ID is already used. The current policy allows approximately 60 API calls per minute per connecting IP. This supports the client's initial one-request-per-second pace; client delays become progressively more conservative after 2,000 candidates.
3. Store both production secrets without printing or committing their values:

   ```sh
   npx wrangler secret put TYPESAFE_API_KEY
   npx wrangler secret put CONTINUATION_SECRET
   ```

4. Review the `SearchSession` Durable Object binding and declarative SQLite class export in `wrangler.jsonc`. The first approved deployment provisions that namespace; no separate database setup is required.
5. Run `npm run check`, then deploy only after reviewing the target account and Worker name:

   ```sh
   npm run deploy
   ```

Cloudflare applies rate-limit counters per location and documents them as permissive/eventually consistent. For a higher-risk or high-volume launch, add a zone-level WAF rate-limiting rule and bot protection in the Cloudflare dashboard as an additional perimeter. The repository does not claim an in-memory isolate counter as protection.

The canonical public URL is `https://whatstheir.at/`. Attach that hostname to the production Worker before launch. A social preview image is not yet configured.

## Privacy and security

The service processes the name and optional context entered by a visitor. It sends name-derived search queries to the public Bluesky/AT Protocol actor-search service. It sends the target name or context and public candidate handle, display-name, or bio fields to Jev for scoring. Candidate profiles are public data. Do not submit secrets or sensitive personal information.

This repository makes no promise about retention by Cloudflare, the AT Protocol service, or Jev; operators should review and disclose the policies that apply to their chosen accounts before launch. API responses and errors are marked `no-store`. Secrets belong in Cloudflare secret bindings or ignored local environment files, never source control.

Search-session state is stored in a SQLite-backed Cloudflare Durable Object. Activity extends its expiry by approximately 15 minutes. An alarm rechecks that deadline and calls `deleteAll()` after inactivity, or the object is cleared immediately when search is exhausted. Alarm execution and platform deletion are not promised to occur at an exact instant, and Cloudflare platform backup/point-in-time-recovery behavior may retain recoverable storage according to the operator's Cloudflare plan and policies.

Continuation tokens do not contain the search input, cursors, or seen DIDs. They contain an opaque session reference, sequence, expiry, input digest, and signature. Short expiry, input binding, Durable Object sequencing, request limits, and safe public errors reduce abuse but do not replace Cloudflare account monitoring and perimeter controls.

## Limitations

- Results depend on the public search index and profile text; an absent or sparse profile may not rank well.
- Scores are heuristic signals, not identity verification. Users should inspect the linked public profile.
- Shared IP addresses can share the public request budget.
- Provider outages, timeouts, or schema changes can temporarily prevent searches.
- The app intentionally has no login, analytics, or long-lived user-profile database; Durable Object storage is limited to ephemeral search progress.

## Contributing

Keep changes small and preserve the plain TypeScript/HTML architecture unless a demonstrated need justifies expansion. Before opening a pull request, run `npm run check` and avoid committing `.env` files, Wrangler state, `dist/`, or provider data. Bug reports should include reproduction steps and expected behavior, but never credentials or personal search inputs.

Licensed under the [MIT License](LICENSE).
