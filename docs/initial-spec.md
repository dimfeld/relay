# Relay — Product & Architecture Specification
Status: Implementation-ready draft
Primary stack: Bun, SvelteKit, TypeScript, SQLite
Networking: Caddy, Cloudflare Tunnel, Tailscale, example.com subdomains
## 1. Purpose
Relay is a small personal integration and automation control plane. It accepts external inputs such as Pebble Index transcriptions, normalizes and classifies them, routes them to the correct owning application, executes narrowly-scoped automation, and keeps an audit trail of what happened.
The Hub should normally stay out of the user's daily workflow. Its web UI exists for focused operational work: reviewing inbound captures, debugging classification, inspecting failed deliveries, monitoring one-off coding agents, and configuring integrations.
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
- “Tim, use Codex to add USPS tracking support to Omni.” → coding.task → local executor initially; Tim may own this later
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
- Execute narrowly-scoped one-off coding jobs through registered project/executor adapters.
- Record processing stages, deliveries, executions, failures, and corrections.
- Provide an administrative web UI for inspection and correction.
## 7. Non-Goals
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
  project?: string
  parameters?: Record<string, unknown>
  requestedExecutor?: {
    provider?: "codex" | "claude"
    model?: string
  }
}
```
## 13. One-Off Coding Execution
For now, Relay may execute small coding requests directly. Tim remains specialized and does not need to be inserted into every one-off coding task. The execution boundary should nevertheless be abstract so Tim can become an executor later.
```text
interface AgentExecutor {
  execute(request: AgentRequest): Promise<AgentResult>
}

Implementations:
- CodexExecutor
- ClaudeExecutor
- future: TimExecutor
```
Coding operations may target only registered projects:
```text
interface Project {
  id: string
  name: string
  aliases: string[]
  directory: string
  defaultBranch: string
  allowedAgents: Array<"codex" | "claude">
  deployment?: DeploymentConfig
}
```
The model must never supply an arbitrary filesystem path. A project name or alias resolves to a pre-approved directory.
## 14. Unattended Agent Contract
- Inspect the repository before editing.
- Do not ask interactive questions; make reasonable choices when ambiguity is minor.
- Do not modify unrelated code.
- Run appropriate tests and validation.
- Create a dedicated branch.
- Commit completed changes.
- Push the branch to origin.
- Do not merge to the default branch unless a separate authorized merge action explicitly requests it.
- Return a concise structured summary including changes, validation, branch, commit SHA, files affected, and unresolved issues.
## 15. Git and Deployment Safety
Default coding workflow:
1. Verify the repository is in an acceptable state.
1. Fetch the remote.
1. Start from the configured base branch.
1. Create an agent branch such as agent/<execution-id>-<slug>.
1. Run the configured agent.
1. Run tests / validation.
1. Commit.
1. Push the branch.
1. Record branch and commit metadata.
Merge and production deployment must be separate, explicitly modeled actions. They should initially require explicit confirmation and must use predefined adapters rather than arbitrary shell commands generated by a model.
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
- coding.task.requested
- coding.task.started
- coding.task.completed
- coding.task.failed
- deploy.requested
- git.merge.requested
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
- executions
- execution_logs
- action_results
- configuration
Domain tables for tasks, reminders, packages, and long-lived notes should not be canonical Hub storage once an owning application exists.
## 19. AI Boundary
Use TypeSafe AI Jev to classify an event into a fixed action type. Use GPT-6 Luna through the Vercel AI SDK to extract the fields for that type and for other in-process language tasks. Codex and Claude handle coding agent execution; Luna does not serve as a coding agent. Ordinary TypeScript determines what operations are permitted and how they execute. Validate extracted fields with Zod before routing or side effects. See [Model Pipeline](model-pipeline.md) for the required call sequence, configuration, failure behavior, and tests.
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
Use deterministic parsing for exact routing, wake-name signals, project aliases, tracking-number recognition, source authentication, and similar unambiguous work.
## 20. Security Model
- Public webhooks use signature verification, shared secret, bearer token, or randomized token path where the source supports it.
- Apply request-size limits and rate limiting to the public listener.
- Internal services use distinct service credentials rather than one shared token.
- Scope internal identities to capabilities such as events:publish, coding:request, or deploy:request.
- Do not store secrets in arbitrary database records; store secret references and load values from environment/secret storage.
- Agent processes receive only required environment variables.
- Never expose execution logs, project paths, or administrative APIs on the public listener.
## 21. Admin UI
The Hub UI should feel like an operations console, not another personal productivity application.
- Activity / inbound event timeline
- Event detail showing raw input, normalization, selected context, classification, policy decision, downstream route, and result
- Agent executions and logs
- Failures / dead letters
- Integrations and routes
- Registered projects
- Settings / wake name / model configuration
Do not add first-class Tasks, Reminders, Notes, or Packages sections to the Hub UI.
## 22. Correction and Reprocessing
- Allow an operator to correct a classification.
- Retain the original model output and create a new correction record.
- Allow reclassification, retry delivery, and retry execution.
- Every retry/reprocess operation creates a new attempt rather than rewriting history.
## 23. Observability
- Assign a correlation ID to every incoming event.
- Propagate it through classification, routing, delivery, and execution.
- Use structured logs.
- Record model/provider name and latency for classifier calls.
- OpenTelemetry is desirable but can be a post-MVP enhancement.
## 24. Failure Semantics
- No input is silently discarded.
- Classification failure → needs_review.
- Delivery failure → durable retry.
- Execution failure → retain stdout/stderr and final state.
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
      projects/
      agents/
      auth/
      logging/

  routes/
    api/
      events/
      executions/
      projects/

    admin/
      activity/
      executions/
      failures/
      projects/
      integrations/

src/public-webhook-server.ts
src/internal-server.ts

workers/
  classifier.ts
  delivery.ts
  agent.ts
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
- Codex and Claude one-off coding executors
- Agent branch/commit/push workflow
- Admin activity/event-detail UI
- Execution list/log UI
- Failure/retry/reclassify controls
- Separate public and internal HTTP exposure
## 27. Deferred / Later
- Tim as a general coding executor
- Production deploy adapters
- Automatic or semi-automatic branch merge workflow
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
| Relay | Capture, normalization, classification, routing, authorization, one-off execution, delivery, audit/debugging | Occasional admin/inspection |

| Interface | Example | Exposure | Responsibilities |
| --- | --- | --- | --- |
| Public webhook | capture.example.com | Cloudflare Tunnel / Internet | Only explicit webhook endpoints; minimal attack surface |
| Internal/admin | integrations.example.com | Tailscale and/or Cloudflare Access | Internal API, admin UI, project execution, configuration |
