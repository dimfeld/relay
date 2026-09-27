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

The internal listener serves `POST /api/events` and the admin read routes `GET /api/events`, `/api/events/:id`, `/api/attempts`, `/api/deliveries`, `/api/deliveries/:id`, `/api/executions`, `/api/executions/:id`, `/api/projects`, `/api/projects/:id`, and `/api/failures`. It also serves the admin action routes `POST /api/events/:id/retry-classification`, `POST /api/deliveries/:id/retry`, `POST /api/events/:id/corrections`, and `POST /api/events/:id/reclassify`. The project API returns the registered project catalog, including aliases, allowed agents, instructions, and policy. The internal app lists the same data at `/projects`. The public listener does not serve these routes.

Each caller sends `Authorization: Bearer <token>`. `INTERNAL_SERVICE_CREDENTIALS` gives each service a distinct token and a list of capabilities:

- `events:publish` lets a service publish events whose `source` is its own service name.
- `coding:request` is also necessary to publish `coding.task.requested`.
- `deploy:request` is also necessary to publish `deploy.requested` and `git.merge.requested`.
- `admin:read` lets a caller use the admin read routes.
- `admin:retry` lets a caller use the admin action routes (retry, correction, and reclassification).

A published event has the envelope `{ "source", "type", "payload", "sourceEventId"? }`. Relay deduplicates by source with `sourceEventId`, or with the `Idempotency-Key` header when there is no `sourceEventId`. A new event returns 202 with `{ eventId }`. A duplicate returns 200 with `{ eventId, duplicate: true }`. Relay routes a published event by its type to the owner integration, without classification.

The internal SvelteKit app includes an Activity page at `/activity`. It lists incoming events newest first with their source, received time, input summary, latest classification, delivery destination, and status. Filters are available for source, status, action type, and date. Failed, unrouted, and needs-review events are highlighted. The page also has a command form for natural-language requests. Relay stores each normal submission as a web capture, then uses the same classifier, validation, routing, and delivery path as Pebble text. Test mode runs the same classifier input preparation and classification, then shows the result, extraction details, proposed action, and matching route. It does not save an event or send the action. Each saved event links to `/activity/:eventId`, a detail view with the raw payload, normalized event, selected context, classification and processing history, recorded action results, route, deliveries, and downstream ID. The action results show the recorded workflow outcome; Relay does not yet record a separate policy decision.

The Failures page at `/failures` lists classification jobs that used all their attempts and dead deliveries, newest first. Each row shows the event, source, type or destination, attempt count, last error, and failure time, and links to the event detail. `GET /api/failures` returns the same lists. A retry puts the item back in its queue with a new attempt budget, so the workers process it again: a classification retry requeues the latest classification job of the event, and a delivery retry schedules the dead delivery again with the same idempotency key. The earlier attempts and failed action results stay in the history. A retry of an item that is not failed returns 409, and an unknown ID returns 404. The Retry button on the page calls the same retry functions.

The event detail page has correction and Reclassify actions. A correction replaces the classification with an action that the operator selects (`task.create`, `reminder.create`, `note.create`, or `note.append`) and fields that the operator enters. Relay validates the fields with the same action schema that routing uses, and an invalid value returns 400. The original classification is not changed. The correction is a new classification with provider `operator`, which records who made it and which classification it replaces, and a new `correction` processing attempt. Relay routes the corrected action at once. Its delivery idempotency key contains the event ID and the correction attempt ID, so the owner gets a new request that stays linked to the source event. The form sends one attempt ID for each correction, so a repeated submission returns the first result and does not dispatch again. `POST /api/events/:id/corrections` takes `{ "attemptId", "actionType", "fields" }` and records the calling service as the operator. Reclassify (`POST /api/events/:id/reclassify`) queues a new classification job for the current classifier, and the worker records a new attempt that is marked as a reclassification. A reclassification routes with the normal idempotency key, so a result with the same action type as an earlier delivery is not sent again. The detail page marks the correction, the classification that it replaces, and the delivery that it dispatched.

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

Set `INTEGRATIONS_CONFIG_PATH` to a JSON file to configure the owner applications and the routes to them. Relay syncs this file to SQLite when the internal server starts. An integration or route that is removed from the file is disabled, not deleted, because delivery history refers to it. `kind` is `mail` or `omniapp`. Each route sets `actionType`, `eventType`, or both. docs/external-app-changes.md defines the Mail API. The file shape is:

```json
{
  "integrations": [
    { "id": "mail", "name": "Mail", "kind": "mail", "baseUrl": "https://mail.example/api/relay" },
    { "id": "omniapp", "name": "OmniApp", "kind": "omniapp", "baseUrl": "https://omni.example/api" }
  ],
  "routes": [
    { "id": "mail-tasks", "actionType": "task.create", "integrationId": "mail" },
    { "id": "mail-reminders", "actionType": "reminder.create", "integrationId": "mail" },
    { "id": "mail-notes", "actionType": "note.create", "integrationId": "mail" },
    { "id": "mail-note-appends", "actionType": "note.append", "integrationId": "mail" },
    { "id": "omniapp-packages", "eventType": "package.detected", "integrationId": "omniapp" }
  ]
}
```

The internal server runs the classification and delivery queue workers. It needs the classifier settings (`TYPESAFE_API_KEY`, `OPENAI_API_KEY`, and the other classifier variables in `.env.example`). `WORKER_POLL_INTERVAL_MS` sets how often an idle worker checks for jobs. `WORKER_STALE_AFTER_MS` sets when a job that a stopped worker claimed becomes available again. The public webhook listener does not run workers.

For a production build, run `bun run build`, then run `bun run start` and `bun run start:public` as separate processes. Both listeners bind to `127.0.0.1`. A later deployment phase will define proxy access.

Run `bun run validate` before a commit. It runs type checks, lint, format checks, tests, and the production build. The configured database path, credentials, and executor are validated at process startup. The internal server opens the database, syncs the project and integration files when they are configured, and starts the queue workers. Relay does not call an external service at startup.
