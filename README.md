# Relay

Relay is an integration service. The SvelteKit app runs on the internal listener. A separate Bun process owns the public webhook listener.

## Run locally

Copy `.env.example` to `.env` and set the secrets, service tokens, and model. Then run:

```sh
bun install
bun run dev
bun run start:public
```

The two commands run in separate terminals. The public listener returns 404 for all paths in Phase 1. The internal health route is `GET /health`.

For a production build, run `bun run build`, then run `bun run start` and `bun run start:public` as separate processes. Both listeners bind to `127.0.0.1`. A later deployment phase will define proxy access.

Run `bun run validate` before a commit. It runs type checks, lint, format checks, tests, and the production build. The configured database path, credentials, model, and executor are validated at process startup. This phase does not open the database or call an external service.
