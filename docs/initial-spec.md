# Relay — Product & Architecture Specification
Status: Implementation-ready draft
Primary stack: Bun, SvelteKit, TypeScript, SQLite
Networking: Caddy, Cloudflare Tunnel, Tailscale, example.com subdomains
## 1. Purpose
Relay is a small personal integration and automation control plane. It accepts external inputs such as Pebble Index transcriptions, normalizes and classifies them, routes them to the correct owning application, executes narrowly-scoped automation, and keeps an audit trail of what happened.
The Hub should normally stay out of the user's daily workflow. Its web UI exists for focused operational work: reviewing inbound captures, debugging classification, inspecting failed deliveries, configuring integrations.
## 2. Application Ownership Model
## 3. Primary User Flows
### 3.1 Pebble capture
```text
Pebble Index
    ↓
public webhook
    ↓
raw immutable event
    ↓
normalization
    ↓
context selection
    ↓
classification
    ↓
policy / authorization
    ↓
route to owner
    ↓
record result
```
Examples:
- “Remind me tomorrow morning to call the dentist.” → reminder.create → Mail
- “Pick up soldering tips.” → task.create → Mail
- “Coffee pourer idea: make the reservoir removable.” → note.create → OmniApp (or a future notes owner)
- “Also make the mounting plate removable.” → note.append → previous note, when context supports it
### 3.2 Cross-application events
Applications publish structured events to the Hub instead of integrating directly with one another. The Hub resolves routes and performs durable delivery.
```text
Mail client
    ↓  package.detected
Relay
    ↓
OmniApp
```
This keeps Mail unaware of OmniApp's internal API and allows routing or ownership to change later without rewriting the source application.
## 4. Attention Model in the Mail Client
Tasks and reminders should be owned by the Mail client because they share the same fundamental property as email: they are items that may require the user's attention. The Mail UI can present them together without forcing Relay to become a task application.
```text
AttentionItem {
  id
  type: "email" | "task" | "reminder"
  title
  body?
  state: "inbox" | "scheduled" | "done" | "archived"
  dueAt?
  remindAt?
  source?: { app, externalId? }
}
```
The actual persistence model may use separate tables. The important requirement is a unified UI abstraction supporting shared operations such as done, snooze, schedule, archive, and open.
## 5. Notes and Reference Data
General notes should not be forced into the Mail client solely to avoid another interface. Notes are primarily reference material, not attention items. In the near term, OmniApp is a reasonable owner for lightweight notes and arbitrary personal reference objects because it is already the general toolbox application.
Relay should treat note ownership as a route, not as a hard-coded architectural assumption. A future dedicated notes service could replace OmniApp without changing the capture pipeline.
## 6. Relay Responsibilities
- Accept public webhook inputs from Pebble and future approved sources.
- Persist the exact original payload before interpretation.
- Normalize source-specific data into internal events.
- Select bounded recent context when classification may depend on earlier captures.
- Classify natural-language captures into validated structured intents/actions.
- Apply deterministic signals before invoking an LLM where possible.
- Apply policy and authorization before any side effect.
- Route actions to the application that owns the resulting object.
- Perform durable HTTP delivery with retries and idempotency.
- Record processing stages, deliveries, failures, and corrections.
- Provide an administrative web UI for inspection and correction.
## 7. Non-Goals
- Directly running coding agents or changing repositories, branches, merges, or deployments.
- Being a daily task, reminder, notes, or package-management UI.
- Replacing Mail, OmniApp, or Tim as domain owners.
- Becoming a general message broker such as Kafka or NATS.
- Giving an LLM unrestricted shell, filesystem, deployment, or merge privileges.
- Maintaining an indefinitely growing conversational context.
- Allowing arbitrary repository paths or arbitrary deployment commands from natural-language input.
## 8. Network and Process Boundary
Use two logically and preferably physically separate HTTP listeners:
Suggested local ports: PUBLIC_PORT=4310, INTERNAL_PORT=4311.
The public listener must not expose administration endpoints, project paths, execution controls, logs, deployment APIs, or general internal routing APIs.
## 9. Core Event Model
Every input begins as an immutable incoming event.
```text
interface IncomingEvent {
  id: string
  source: string
  sourceEventId?: string
  type: string
  receivedAt: string
  payload: unknown
  text?: string
  metadata?: Record<string, unknown>
}
```
Derived processing information must be stored separately so reclassification or retries never overwrite the original source.
## 10. Intent / Action Model
The classifier should emit validated structured actions rather than free-form prose.
```text
type CapturedIntent =
  | { type: "task.create"; title: string; notes?: string; dueAt?: string }
  | { type: "reminder.create"; text: string; remindAt: string; originalTimePhrase?: string }
  | { type: "note.create"; title?: string; body: string; topic?: string }
  | { type: "note.append"; targetId: string; body: string }
  | { type: "tim.plan.create"; project: string; description: string }
  | { type: "tim.plan.create_and_execute"; project: string; description: string }
  | { type: "command.execute"; command: ParsedCommand }
  | { type: "unknown"; reason?: string }
```
The Hub records the action it chose and the downstream object ID returned by the owning application, but the canonical task, reminder, note, package, or project object lives in that application.
## 11. Context-Aware Classification
- Classification may include the last N captures and a maximum age window.
- Recent captures should be favored strongly; old unrelated history should not be injected.
- A continuation must identify the target object or prior event explicitly.
- The selected context should be recorded with the processing attempt for debugging.
- Context should be bounded and database-driven, not an endlessly accumulating chat transcript.
Reasonable initial defaults: last 10 captures, maximum age 15 minutes, with strong weighting for captures within roughly 2 minutes.
## 12. Command / Wake-Name Behavior
A configurable wake name should act as a strong signal for command classification, but not as the only criterion. The classifier should still determine whether the utterance is actually an instruction.
```text
interface ParsedCommand {
  action: string
  target?: string
  parameters?: Record<string, unknown>
}
```
## 13. Project Catalog

Relay keeps a read-only catalog of registered projects for reference and routing. Each project has an ID, name, aliases, directory, and optional instructions. Resolve project names through registered aliases and validate configured directories. A catalog entry supplies the directory for Tim plan actions. Relay does not run coding agents or change repository files.

## 14. Tim Plan Actions

- `tim.plan.create`: Create a plan in a registered project.
- `tim.plan.create_and_execute`: Create a simple plan in a registered project and queue it for Tim execution.

Both actions require a project name or alias and a non-empty description. Resolve the project through the catalog and run `tim add <description> --details <description>` with that project directory as the working directory. For the second action, also pass `--simple --status queued`. For normal creation, retain Tim defaults. Use a fixed executable and an argument array without a shell. Treat the description as data, including text that resembles CLI options.

Record the returned plan ID, project, queue mode, and command outcome. Keep dispatch durable and avoid creating another plan on duplicate input or a retry after recorded success. If command completion is uncertain, reconcile the result before another creation attempt. Missing or unknown projects and invalid descriptions require review before dispatch.

Tim owns the plan and its execution. Setting simple and status queued is the complete Relay request for immediate execution; Tim's queue must be configured to process it. Relay does not start `tim agent`.

## 16. Internal Integration API
```text
POST /api/events

{
  "source": "mail",
  "type": "package.detected",
  "payload": {
    "carrier": "ups",
    "trackingNumber": "1Z..."
  }
}
```
Use namespaced event types such as:
- voice.transcription
- task.create
- reminder.create
- note.create
- note.append
- package.detected
- tim.plan.create
- tim.plan.create_and_execute
## 17. Durable Delivery and Idempotency
- Persist every outgoing delivery before attempting it.
- Use retry with exponential backoff.
- Maintain a dead-letter / failed state after repeated failures.
- Use source + sourceEventId for source deduplication where available.
- Support Idempotency-Key on internal APIs.
- Send the Hub event ID downstream so receiving applications can deduplicate side effects.
## 18. SQLite and Queueing
SQLite is sufficient for the initial durable event log and job queues.
Suggested tables:
- incoming_events
- processing_attempts
- classifications
- jobs
- integrations
- event_routes
- deliveries
- projects
- action_results
- configuration
Domain tables for tasks, reminders, packages, and long-lived notes should not be canonical Hub storage once an owning application exists.
## 19. AI Boundary
Use TypeSafe AI Jev to classify an event into a fixed action type. Use GPT-6 Luna through the Vercel AI SDK to extract the fields for that type and for other in-process language tasks. Ordinary TypeScript determines what operations are permitted and how they execute. Validate extracted fields with Zod before routing or side effects. See [Model Pipeline](model-pipeline.md) for the required call sequence, configuration, failure behavior, and tests.
```text
normalize
    ↓
deterministic signals
    ↓
Jev action choice
    ↓
Luna field extraction for the selected action
    ↓
Zod schema validation
    ↓
policy / authorization
    ↓
dispatch
```
Use deterministic parsing for exact routing, wake-name signals, tracking-number recognition, source authentication, and similar unambiguous work.
## 20. Security Model
- Public webhooks use signature verification, shared secret, bearer token, or randomized token path where the source supports it.
- Apply request-size limits and rate limiting to the public listener.
- Internal services use distinct service credentials rather than one shared token.
- Scope internal identities to capabilities such as events:publish or admin:read.
- Do not store secrets in arbitrary database records; store secret references and load values from environment/secret storage.
- Never expose event records, logs, or administrative APIs on the public listener.
## 21. Admin UI
The Hub UI should feel like an operations console, not another personal productivity application.
- Activity / inbound event timeline
- Event detail showing raw input, normalization, selected context, classification, policy decision, downstream route, and result
- Failures / dead letters
- Integrations and routes
- Registered projects
- Settings / wake name / model configuration
Do not add first-class Tasks, Reminders, Notes, or Packages sections to the Hub UI.
## 22. Correction and Reprocessing
- Allow an operator to correct a classification.
- Retain the original model output and create a new correction record.
- Allow reclassification and delivery retry.
- Every retry/reprocess operation creates a new attempt rather than rewriting history.
## 23. Observability
- Assign a correlation ID to every incoming event.
- Propagate it through classification, routing and delivery.
- Use structured logs.
- Record model/provider name and latency for classifier calls.
- OpenTelemetry is desirable but can be a post-MVP enhancement.
## 24. Failure Semantics
- No input is silently discarded.
- Classification failure → needs_review.
- Delivery failure → durable retry.
- Invalid or unauthorized command → rejected/needs_review with a recorded reason.
## 25. Suggested Repository Structure
```text
src/
  lib/
    server/
      db/
      events/
      classifier/
      routing/
      integrations/
      queue/
      commands/
      auth/
      logging/

  routes/
    api/
      events/

    admin/
      activity/
      failures/
      integrations/

src/public-webhook-server.ts
src/internal-server.ts

workers/
  classifier.ts
  delivery.ts
  reminder-dispatch.ts
```
## 26. MVP Scope
- Pebble public webhook and raw payload persistence
- Normalized voice capture events
- Task / reminder / note / note continuation / command / unknown classification
- Bounded recent-context selection
- Mail adapter for task and reminder creation
- OmniApp adapter for package events and optionally notes/reference captures
- Generic internal event publishing API
- Durable delivery queue with retry/idempotency
- Registered project catalog
- Tim plan creation and simple queued plan creation
- Admin activity/event-detail UI
- Failure/retry/reclassify controls
- Separate public and internal HTTP exposure
## 27. Deferred / Later
- Rich notes/search backend
- Location-aware reminders
- Semantic note retrieval
- Additional capture sources such as Slack, email, or SMS
- Workflow DSL / conditional routing
- Human approval queues
- OpenTelemetry traces and richer metrics
## 28. Design Rules to Preserve
- Preserve the source.
- Keep ownership in domain applications.
- Keep model decisions structured and validated.
- Keep side effects explicit and policy-controlled.
- Prefer durable queues and idempotent operations.
- Minimize the public attack surface.
- Make every important action auditable.
- Keep the Hub replaceable and loosely coupled to downstream applications.

---

## Reference Tables

> Core product principle: Relay is infrastructure, not a fourth daily-use application. Mail is the personal attention surface, OmniApp owns structured/reference utility data, Tim owns planned project work and longer-running agent workflows, and Integration Hub connects them.

| Application | Owns | Typical user interaction |
| --- | --- | --- |
| Mail client | Attention items: email, to-dos, reminders, snoozed/future attention | Frequent / daily |
| OmniApp | Structured personal utility and reference data such as packages, trackers, lists, devices, lightweight reference objects | As needed |
| Tim | Projects, planned coding work, software-factory workflows, multi-step agent work | Focused project work |
| Relay | Capture, normalization, classification, routing, authorization, delivery, audit/debugging | Occasional admin/inspection |

| Interface | Example | Exposure | Responsibilities |
| --- | --- | --- | --- |
| Public webhook | capture.example.com | Cloudflare Tunnel / Internet | Only explicit webhook endpoints; minimal attack surface |
| Internal/admin | integrations.example.com | Tailscale and/or Cloudflare Access | Internal API, admin UI, configuration |
