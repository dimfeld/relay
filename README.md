# Relay

Relay is an integration service. The SvelteKit app runs on the internal listener. A separate Bun process owns the public webhook listener.

## SvelteKit conventions

Use SvelteKit [remote functions](https://svelte.dev/docs/kit/remote-functions) for data queries and form submissions by default. Use another SvelteKit pattern when a specific feature or requirement gives a better reason.

## Run locally

Copy `.env.example` to `.env` and set the secrets, service tokens, and model. Then run:

```sh
bun install
bun run dev
bun run start:public
```

The two commands run in separate terminals. The public listener serves only `POST /webhooks/pebble`. The internal health route is `GET /health`.

## Internal API

The internal listener serves `POST /api/events` and the admin read routes `GET /api/events`, `/api/events/:id`, `/api/attempts`, `/api/deliveries`, `/api/deliveries/:id`, `/api/executions`, `/api/executions/:id`, `/api/projects`, and `/api/projects/:id`. List routes return rows newest first. They return all rows unless the request sets `?limit=`. The public listener does not serve these routes.

Each caller sends `Authorization: Bearer <token>`. `INTERNAL_SERVICE_CREDENTIALS` gives each service a distinct token and a list of capabilities:

- `events:publish` lets a service publish events whose `source` is its own service name.
- `coding:request` is also necessary to publish `coding.task.requested`.
- `deploy:request` is also necessary to publish `deploy.requested` and `git.merge.requested`.
- `admin:read` lets a caller use the admin read routes.

A published event has the envelope `{ "source", "type", "payload", "sourceEventId"? }`. Relay deduplicates by source with `sourceEventId`, or with the `Idempotency-Key` header when there is no `sourceEventId`. A new event returns 202 with `{ eventId }`. A duplicate returns 200 with `{ eventId, duplicate: true }`. Relay routes a published event by its type to the owner integration, without classification.

For a production build, run `bun run build`, then run `bun run start` and `bun run start:public` as separate processes. Both listeners bind to `127.0.0.1`. A later deployment phase will define proxy access.

Run `bun run validate` before a commit. It runs type checks, lint, format checks, tests, and the production build. The configured database path, credentials, model, and executor are validated at process startup. This phase does not open the database or call an external service.
