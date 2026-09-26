# Changes Owned by Other Applications

This document records work outside the Relay repository. The Relay tim plans cover Relay adapters, contracts, and tests with local fakes. They do not change Mail or OmniApp. Phase 19 network deployment is manual work and is not in the tim plans.

## Pebble Index

- Configure the transcription webhook to send requests to Relay's public `POST /webhooks/pebble` endpoint when that endpoint is deployed.
- Configure a source credential that Pebble Index supports and that Relay can verify. Confirm the payload fields and whether Pebble Index supplies a stable event ID before live ingestion tests.

## Mail

- Accept Relay `task.create` requests and create Mail-owned tasks. Return the Mail task ID. Honor a stable Relay idempotency key so delivery retries do not create duplicate tasks.
- Accept Relay `reminder.create` requests with text, `remindAt`, time zone, original time phrase, and source event ID. Mail must store, schedule, and surface the reminder. Return the Mail reminder ID and honor the idempotency key. Relay must not schedule the user-facing notification.
- Publish Mail-owned `package.detected` events to Relay's internal `POST /api/events` when package data needs delivery to OmniApp. Send `Authorization: Bearer <mail token>`, `source: "mail"`, and a stable `sourceEventId` or `Idempotency-Key` header. Relay configures the Mail service identity with only the `events:publish` capability.
- Define the exact request and response fields with Relay before a live integration test. The Relay plans can use local fake Mail endpoints until this contract is available.

## OmniApp

- Accept `package.detected` deliveries from Relay and create or update the OmniApp-owned package record. Return its object ID and honor Relay's idempotency key.
- If OmniApp is selected as the notes owner, accept `note.create` and `note.append`, return the owned note ID, and honor idempotency keys. Confirm note ownership before Relay enables these routes.
- If OmniApp publishes structured events to Relay, use its own service token and `source: "omniapp"`. Relay gives the OmniApp identity `events:publish`, plus `coding:request` or `deploy:request` only if OmniApp must publish `coding.task.requested`, `deploy.requested`, or `git.merge.requested`.
- Define the exact request and response fields with Relay before a live integration test. The Relay plans can use local fake OmniApp endpoints until this contract is available.

## Integration proof

Relay's automated acceptance suite should use local fake services for these contracts. A later live test needs the Mail and OmniApp changes above and access to those applications. Do not mark a live cross-app flow complete from a fake-service result.
