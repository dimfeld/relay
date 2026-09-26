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

The internal listener serves `POST /api/events` and the admin read routes `GET /api/events`, `/api/events/:id`, `/api/attempts`, `/api/deliveries`, `/api/deliveries/:id`, `/api/executions`, `/api/executions/:id`, `/api/projects`, `/api/projects/:id`, and `/api/failures`. It also serves the admin retry routes `POST /api/events/:id/retry-classification` and `POST /api/deliveries/:id/retry`. The project API returns the registered project catalog, including aliases, allowed agents, instructions, and policy. The internal app lists the same data at `/projects`. The public listener does not serve these routes.

Each caller sends `Authorization: Bearer <token>`. `INTERNAL_SERVICE_CREDENTIALS` gives each service a distinct token and a list of capabilities:

- `events:publish` lets a service publish events whose `source` is its own service name.
- `coding:request` is also necessary to publish `coding.task.requested`.
- `deploy:request` is also necessary to publish `deploy.requested` and `git.merge.requested`.
- `admin:read` lets a caller use the admin read routes.
- `admin:retry` lets a caller use the admin retry routes.

A published event has the envelope `{ "source", "type", "payload", "sourceEventId"? }`. Relay deduplicates by source with `sourceEventId`, or with the `Idempotency-Key` header when there is no `sourceEventId`. A new event returns 202 with `{ eventId }`. A duplicate returns 200 with `{ eventId, duplicate: true }`. Relay routes a published event by its type to the owner integration, without classification.

The internal SvelteKit app includes an Activity page at `/activity`. It lists incoming events newest first with their source, received time, input summary, latest classification, delivery destination, and status. Filters are available for source, status, action type, and date. Failed, unrouted, and needs-review events are highlighted. Each event links to `/activity/:eventId`, a read-only detail view with the raw payload, normalized event, selected context, classification and processing history, recorded action results, route, deliveries, and downstream ID. The action results show the recorded workflow outcome; Relay does not yet record a separate policy decision.

The Failures page at `/failures` lists classification jobs that used all their attempts and dead deliveries, newest first. Each row shows the event, source, type or destination, attempt count, last error, and failure time, and links to the event detail. `GET /api/failures` returns the same lists. A retry puts the item back in its queue with a new attempt budget, so the workers process it again: a classification retry requeues the latest classification job of the event, and a delivery retry schedules the dead delivery again with the same idempotency key. The earlier attempts and failed action results stay in the history. A retry of an item that is not failed returns 409, and an unknown ID returns 404. The Retry button on the page calls the same retry functions.

## Registered projects

Set `PROJECTS_CONFIG_PATH` to a JSON file to register approved project directories. Relay reads and validates this file when the internal server starts, then syncs the project catalog to SQLite. Each directory must be an existing absolute path. Project IDs, names, and aliases must identify one project without collisions. The file shape is:

```json
{
  "projects": [
    {
      "id": "omniapp",
      "name": "OmniApp",
      "aliases": ["Omni"],
      "directory": "/absolute/path/to/OmniApp",
      "defaultBranch": "main",
      "allowedAgents": ["codex", "claude"],
      "instructions": "Keep project changes focused.",
      "policy": {
        "allowPush": true,
        "allowMerge": false,
        "allowDeploy": false
      }
    }
  ]
}
```

`aliases`, `instructions`, and `policy` are optional. Push is allowed by default to match the branch-push workflow in the agent contract. Merge and deploy are blocked by default. Project lookup accepts a registered ID, name, or alias. It does not accept a filesystem path.

For a production build, run `bun run build`, then run `bun run start` and `bun run start:public` as separate processes. Both listeners bind to `127.0.0.1`. A later deployment phase will define proxy access.

Run `bun run validate` before a commit. It runs type checks, lint, format checks, tests, and the production build. The configured database path, credentials, and executor are validated at process startup. The internal server opens the database and syncs the project file when one is configured. Relay does not call an external service at startup.
