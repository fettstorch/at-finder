# AT Finder

A small app for finding likely AT Protocol accounts from a person's name and optional context.

## Local development

```sh
npm install
cp .env.example .env.local
npm run local
```

Set `TYPESAFE_API_KEY` in `.env.local` before starting the app. AT Protocol profile search does not require a key.

`npm run local` starts the Vite development server with the API running in the Cloudflare Workers runtime.

```sh
curl -X POST http://localhost:3000/api/find \
  -H 'content-type: application/json' \
  -d '{"name":"Jane Smith","context":"CEO of Acme"}'
```

The resolver reads public AT Protocol actor search results in batches of 100. Jev separately scores name similarity, context support, and context contradiction. The UI continuously searches later batches and keeps the ten strongest matches found so far.

## Deployment

Set the production secret once, then deploy the website and Worker together:

```sh
npx wrangler secret put TYPESAFE_API_KEY
npm run deploy
```
