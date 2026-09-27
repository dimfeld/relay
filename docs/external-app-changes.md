# Changes Owned by Other Applications

This document records work outside the Relay repository. The Relay tim plans cover Relay adapters, contracts, and tests with local fakes. They do not change Mail or OmniApp. Phase 19 network deployment is manual work and is not in the tim plans.

## Pebble Index

- Configure the transcription webhook to send requests to Relay's public `POST /webhooks/pebble` endpoint when that endpoint is deployed.
- Configure a source credential that Pebble Index supports and that Relay can verify. Confirm the payload fields and whether Pebble Index supplies a stable event ID before live ingestion tests.

## Mail

Mail owns todos, notes, and categories. Relay only creates them. Relay does not keep a copy and does not schedule notifications.

### API contract

Relay calls these endpoints relative to the Mail base URL that is configured on the Mail integration in Relay. For example, if the base URL is `https://mail.example/api/relay`, Relay sends todos to `https://mail.example/api/relay/todos`. Relay does not send an `Authorization` header at this time. Protect these endpoints at the network level until an authentication scheme is agreed.

#### Common request headers

| Header | Requests | Value |
| --- | --- | --- |
| `Accept` | All | `application/json` |
| `Content-Type` | All `POST` requests | `application/json` |
| `Idempotency-Key` | All `POST` requests | An opaque string that is stable for one delivery. Relay sends the same key when it retries the same delivery. |
| `X-Correlation-ID` | All | An opaque string that identifies the Relay capture. Log it to help trace a request across both applications. |

#### Idempotency

When Mail receives a `POST` with an `Idempotency-Key` that it has already processed successfully, Mail must not create a second object. Mail must return a 2xx response with the `id` of the object that the first request created. Mail must store keys for at least as long as Relay can retry a delivery.

#### Responses and errors

- On success, return HTTP 200 or 201 with a JSON object that contains a non-empty string `id`: `{ "id": "<Mail object ID>" }`. Other fields are allowed and Relay ignores them.
- A 2xx response without a string `id` is a permanent failure. Relay does not retry it.
- Relay retries HTTP 408, HTTP 429, HTTP 5xx, and network failures with backoff. Return one of these statuses only when a later retry can succeed.
- Relay does not retry other statuses, such as HTTP 400, 404, or 422. Mail can include a JSON body such as `{ "error": "<message>" }`. Relay records the body for the operator.

#### Field conventions

- Date-times are ISO 8601 strings with a UTC offset, for example `2026-09-26T09:00:00-07:00`.
- Time zones are IANA names, for example `America/Los_Angeles`.
- Relay always sends every field in the request body. A field that has no value is `null`, not missing.
- `sourceEventId` is the Relay event ID of the capture. Store it so that a Mail object can be traced back to its capture.

#### `GET /categories`

Relay reads the list of categories before it classifies each capture. The classifier can assign one of these categories to a todo or a new note, or no category when none clearly fits. Relay sends the category `id` back to Mail unchanged.

Response, HTTP 200:

```json
{
  "categories": [
    { "id": "cat_123", "name": "Home" },
    { "id": "cat_456", "name": "Work" }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `categories` | array | Can be empty. |
| `categories[].id` | string, not empty | The stable Mail category ID. |
| `categories[].name` | string, not empty | The name the classifier uses to choose a category. A clear, specific name gives better results. |

If this request fails or the response does not have this shape, Relay classifies the capture without a category. The capture is not lost.

#### `POST /todos`

Creates a todo. A reminder is a todo that has a due date and time. Mail must schedule and surface a todo notification at `dueAt`. Relay must not schedule the notification. Mail must be able to fire a notification while Relay is stopped.

Request body:

```json
{
  "title": "Call the dentist",
  "notes": null,
  "dueAt": "2026-09-26T09:00:00-07:00",
  "timeZone": "America/Los_Angeles",
  "originalTimePhrase": "tomorrow at 9am",
  "categoryId": "cat_123",
  "sourceEventId": "evt_789"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string, not empty | The todo text. |
| `notes` | string or `null` | Extra details. |
| `dueAt` | date-time string or `null` | When the todo is due. A reminder always has a value. `null` means that the todo has no due time. |
| `timeZone` | string or `null` | The IANA time zone that Relay used to resolve `dueAt`, when the capture was a reminder. Use it to show the time as the user said it. |
| `originalTimePhrase` | string or `null` | The time words as the user said them, for example `tomorrow at 9am`. |
| `categoryId` | string or `null` | An `id` from `GET /categories`, or `null` for no category. If the category no longer exists, create the todo without a category. Do not reject the request. |
| `sourceEventId` | string | The Relay event ID. |

Response: `{ "id": "<Mail todo ID>" }`.

#### `POST /notes`

Creates a note.

Request body:

```json
{
  "title": "Coffee pourer",
  "body": "Make the reservoir removable.",
  "topic": "coffee",
  "categoryId": null,
  "sourceEventId": "evt_790"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string or `null` | A short title. |
| `body` | string, not empty | The note content. |
| `topic` | string or `null` | A one or two word topic. |
| `categoryId` | string or `null` | An `id` from `GET /categories`, or `null` for no category. If the category no longer exists, create the note without a category. Do not reject the request. |
| `sourceEventId` | string | The Relay event ID. |

Response: `{ "id": "<Mail note ID>" }`. Relay stores this ID so that a later capture can add text to the note.

#### `POST /notes/append`

Adds text to the end of a note that Mail created from an earlier `POST /notes` request.

Request body:

```json
{
  "body": "Also make the mounting plate removable.",
  "targetId": "note_555",
  "contextEventId": "evt_790",
  "sourceEventId": "evt_791"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `body` | string, not empty | The text to add. |
| `targetId` | string | The Mail note ID that `POST /notes` returned. |
| `contextEventId` | string | The Relay event ID of the capture that created or last changed the target note. |
| `sourceEventId` | string | The Relay event ID of this capture. |

Response: `{ "id": "<Mail note ID>" }`. If `targetId` does not exist, return HTTP 404. Relay does not retry it.

### Events that Mail publishes

- Publish Mail-owned `package.detected` events to Relay's internal `POST /api/events` when package data needs delivery to OmniApp. Send `Authorization: Bearer <mail token>`, `source: "mail"`, and a stable `sourceEventId` or `Idempotency-Key` header. Relay configures the Mail service identity with only the `events:publish` capability.

## OmniApp

- Accept `package.detected` deliveries from Relay and create or update the OmniApp-owned package record. Return its object ID and honor Relay's idempotency key.
- If OmniApp publishes structured events to Relay, use its own service token and `source: "omniapp"`. Relay gives the OmniApp identity `events:publish`.
- Define the exact request and response fields with Relay before a live integration test. The Relay plans can use local fake OmniApp endpoints until this contract is available.

## Tim

- Install the Tim CLI where Relay runs and configure the registered project directories for `tim add`.
- Configure Tim's queue to process plans with `simple: true` and `status: queued`. Relay creates and queues the plan; Tim owns generation and execution.
- Normal plan creation uses Tim defaults and does not request immediate execution.

## Integration proof

Relay's automated acceptance suite should use local fake services for these contracts. A later live test needs the Mail and OmniApp changes above and access to those applications. Do not mark a live cross-app flow complete from a fake-service result.
