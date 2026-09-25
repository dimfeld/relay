# Relay — Coding Agent Implementation Checklist
Purpose: Sequential implementation plan for an unattended coding agent.
## 0. Global Implementation Constraints
- ☐ Use Bun, SvelteKit, TypeScript, and SQLite. oxfmt and oxlint as well.
- ☐ Keep the public webhook listener and internal/admin listener separate.
- ☐ Do not make Relay the canonical owner of tasks, reminders, packages, or project work.
- ☐ Use schema-validated structured outputs for LLM classification.
- ☐ Do not allow model-generated arbitrary shell commands, filesystem paths, merge commands, or deployment commands.
- ☐ Persist original incoming data before performing interpretation or side effects.
- ☐ Make side-effecting operations idempotent where practical.
- ☐ Every retry/reprocess operation must create new history rather than overwriting old history.
- ☐ Add tests with each phase; do not defer all tests to the end.
## Phase 1 — Project Skeleton
Objective: Create the application foundation and establish clear module boundaries.
### Tasks
- ☑ Initialize the Bun/SvelteKit TypeScript application.
- ☑ Add environment configuration for PUBLIC_PORT, INTERNAL_PORT, DATABASE_PATH, public webhook secret(s), internal service credentials, and model/executor settings.
- ☑ Create server module directories for db, events, classifier, routing, integrations, queue, commands, projects, agents, auth, and logging.
- ☑ Add a single typed configuration loader that validates required environment variables at startup.
- ☑ Add structured application logging with correlation/event IDs as fields.
- ☑ Add a health endpoint to the internal listener only.
- ☑ Add lint/typecheck/test scripts and a CI-friendly validation command.
### Done when
- ☑ App boots under Bun.
- ☑ Configuration errors fail fast with a clear message.
- ☑ Internal health endpoint responds successfully.
- ☑ Public listener exposes no health/admin endpoint.
- ☑ Typecheck and baseline tests pass.
## Phase 2 — SQLite Foundation and Migrations
Objective: Create durable storage for events, attempts, jobs, routing, delivery, and executions.
### Tasks
- ☐ Choose and configure a SQLite access layer compatible with Bun.
- ☐ Implement migrations.
- ☐ Create incoming_events table with immutable source payload storage.
- ☐ Create processing_attempts table for stage-by-stage history.
- ☐ Create jobs table with status, payload, attempts, available_at, locked_at, and locked_by.
- ☐ Create classifications table storing validated result plus model/provider metadata.
- ☐ Create integrations and event_routes tables.
- ☐ Create deliveries table.
- ☐ Create projects table.
- ☐ Create executions and execution_logs tables.
- ☐ Create action_results/configuration tables as needed.
- ☐ Add indexes for event lookup, job claiming, pending deliveries, and execution status.
- ☐ Add repository/data-access modules rather than using raw SQL throughout route handlers.
### Done when
- ☐ Fresh database can be created entirely from migrations.
- ☐ Migration command is idempotent.
- ☐ Unit/integration tests demonstrate insert/read/update flows for each major table.
- ☐ Original incoming payload cannot be accidentally overwritten by normal repository APIs.
## Phase 3 — Public Pebble Webhook
Objective: Accept Pebble Index transcriptions through a minimal internet-facing endpoint.
### Tasks
- ☐ Create the separate public HTTP listener.
- ☐ Implement POST /webhooks/pebble.
- ☐ Add source authentication supported by the Pebble webhook configuration; if only a shared secret/token is available, validate it before processing.
- ☐ Apply request body size limits and basic rate limiting.
- ☐ Persist the exact raw request body/parsed payload before classification.
- ☐ Extract normalized transcription text and source metadata into an incoming event.
- ☐ Capture a source event ID if Pebble supplies one; otherwise generate a Hub event ID.
- ☐ Add duplicate detection where a stable source event ID exists.
- ☐ Enqueue classification asynchronously after persistence.
- ☐ Return quickly after durable acceptance; do not block the webhook request on LLM classification.
### Done when
- ☐ Valid webhook creates exactly one incoming event and one classification job.
- ☐ Duplicate webhook with the same source ID does not duplicate downstream work.
- ☐ Invalid authentication is rejected without event creation.
- ☐ Malformed payload is retained or logged safely with a useful failure state.
- ☐ No internal/admin endpoints are reachable on the public listener.
## Phase 4 — Event and Job Processing Infrastructure
Objective: Provide a small durable queue using SQLite.
### Tasks
- ☐ Implement atomic job claiming.
- ☐ Implement worker identity and stale-lock recovery.
- ☐ Implement job status transitions: pending, running, succeeded, failed, dead.
- ☐ Implement retry attempts and available_at scheduling.
- ☐ Add exponential backoff with sensible caps.
- ☐ Ensure a process crash after job claim does not permanently lose the job.
- ☐ Create worker loops for classification, delivery, and agent execution.
- ☐ Keep workers separable even if they run in one process initially.
### Done when
- ☐ Two worker instances cannot successfully process the same job concurrently.
- ☐ Failed jobs retry according to schedule.
- ☐ Stale locked jobs become processable again.
- ☐ Dead jobs remain inspectable in the database.
## Phase 5 — Classification and Schema Validation
Objective: Turn normalized voice captures into explicit typed actions.
### Tasks
- ☐ Define Zod schemas for task.create, reminder.create, note.create, note.append, command.execute, and unknown.
- ☐ Define a classifier provider interface independent of a specific LLM SDK.
- ☐ Implement one initial provider/model configuration.
- ☐ Build a system prompt that requests only schema-valid structured output.
- ☐ Record model/provider, latency, token/cost metadata when available.
- ☐ Store a short operational explanation only; do not persist hidden chain-of-thought.
- ☐ Validate every model result before routing.
- ☐ On schema failure, retry once with a repair request or mark needs_review.
- ☐ Add deterministic preprocessing for obvious wake-name detection, project alias hints, and other exact signals.
### Done when
- ☐ Representative utterances classify into all supported action types.
- ☐ Invalid model JSON cannot trigger a side effect.
- ☐ Classifier failure leaves the source event recoverable and visible as needs_review.
- ☐ Tests cover reminder parsing, task classification, note creation, command classification, and unknown input.
## Phase 6 — Context and Note Continuation
Objective: Allow recent related captures to influence classification without creating unbounded conversational state.
### Tasks
- ☐ Implement a context selector that retrieves at most the configured number of recent captures.
- ☐ Apply a maximum age window.
- ☐ Prefer very recent captures over older ones.
- ☐ Include prior classification/action IDs in context when useful.
- ☐ Record which context items were supplied to the classifier.
- ☐ Require note.append to resolve to an explicit target object/event.
- ☐ If the target is ambiguous or unavailable, degrade to note.create or needs_review rather than guessing.
- ☐ Add tests for continuation vs new-note behavior.
### Done when
- ☐ A follow-up such as 'Also make the reservoir removable' can append to a recent relevant note.
- ☐ An unrelated later capture does not accidentally append to old context.
- ☐ The event detail record can show exactly which context influenced classification.
## Phase 7 — Routing and Application Ownership
Objective: Route actions to the correct domain owner rather than storing domain state in Relay.
### Tasks
- ☐ Implement integration registry and event route resolution.
- ☐ Create a Mail adapter for task.create and reminder.create.
- ☐ Create an OmniApp adapter for package.detected and optionally note.create/note.append if OmniApp is the initial notes owner.
- ☐ Keep routing configuration-driven where practical.
- ☐ Persist the selected route before delivery.
- ☐ Persist the downstream object ID returned by the destination.
- ☐ Do not add canonical Hub task/reminder/package tables.
- ☐ Define a stable internal envelope carrying event ID, correlation ID, action type, payload, and idempotency key.
### Done when
- ☐ Task capture results in a Mail-owned object.
- ☐ Reminder capture results in a Mail-owned object.
- ☐ Package event from Mail can route to OmniApp.
- ☐ Hub history shows the owning destination and returned object ID.
- ☐ Changing a route does not require changing the classifier schema.
## Phase 8 — Durable HTTP Delivery
Objective: Make cross-application delivery reliable and observable.
### Tasks
- ☐ Persist delivery rows before making HTTP requests.
- ☐ Send a stable idempotency key/event ID downstream.
- ☐ Implement success/failure transitions.
- ☐ Implement retry with exponential backoff.
- ☐ Record HTTP status and a bounded/sanitized response body for debugging.
- ☐ Add dead-letter handling after the configured retry limit.
- ☐ Add manual retry support from the service layer.
- ☐ Ensure secrets/Authorization headers are never written to logs.
### Done when
- ☐ Transient destination failure retries automatically.
- ☐ Permanent failure remains visible and retryable.
- ☐ Repeated retries do not create duplicate downstream objects when the receiver honors idempotency.
## Phase 9 — Internal API and Authentication
Objective: Allow trusted applications to publish structured events and inspect Hub state.
### Tasks
- ☐ Implement POST /api/events on the internal listener.
- ☐ Validate event envelopes and payload size.
- ☐ Implement distinct service identities/tokens for Mail, OmniApp, and future Tim integration.
- ☐ Add capability checks such as events:publish and coding:request.
- ☐ Implement GET endpoints needed by the admin UI for events, processing attempts, deliveries, executions, and projects.
- ☐ Ensure none of these endpoints are mounted on the public listener.
### Done when
- ☐ Mail can publish package.detected.
- ☐ Unauthorized service tokens are rejected.
- ☐ A token without coding:request cannot start a coding task.
- ☐ Public listener cannot access internal APIs.
## Phase 10 — Project Registry
Objective: Constrain one-off coding work to approved repositories.
### Tasks
- ☐ Implement project configuration/storage with id, name, aliases, directory, default branch, allowed agents, and optional project instructions.
- ☐ Resolve natural-language project names through registered aliases.
- ☐ Reject unregistered project paths.
- ☐ Validate configured project directories at startup or registration time.
- ☐ Expose read-only project listing/detail in the admin UI/API.
- ☐ Add per-project policy flags for agent push, merge, and deploy.
### Done when
- ☐ ‘Omni’ reliably resolves to the configured OmniApp repository.
- ☐ A model-provided arbitrary path is ignored/rejected.
- ☐ Project policies are available before any execution starts.
## Phase 11 — Codex and Claude Executors
Objective: Run one-off coding tasks safely without requiring Tim.
### Tasks
- ☐ Define AgentExecutor interface.
- ☐ Implement CodexExecutor.
- ☐ Implement ClaudeExecutor.
- ☐ Run processes with an explicit working directory and controlled environment.
- ☐ Capture stdout/stderr incrementally into execution_logs.
- ☐ Support timeout/cancellation.
- ☐ Create an unattended prompt wrapper with repository/task context and no-interactive-question instruction.
- ☐ Do not allow the classifier to invent arbitrary executable names or CLI flags outside the executor adapter.
- ☐ Record requested provider/model and actual provider/model.
### Done when
- ☐ A test project can execute a no-op/safe coding task with each configured executor.
- ☐ Execution logs stream/persist correctly.
- ☐ Timeout terminates the child process and records failure.
- ☐ Executor cannot leave the registered project directory through model-selected working-directory changes.
## Phase 12 — Git Branch Lifecycle
Objective: Make unattended coding output reviewable and non-destructive by default.
### Tasks
- ☐ Before execution, verify repository state against policy.
- ☐ Fetch the configured remote.
- ☐ Create a branch using agent/<execution-id>-<slug>.
- ☐ Run the agent on that branch.
- ☐ Run configured validation/test commands after the agent completes.
- ☐ Commit changes with execution metadata.
- ☐ Push the branch if allowed by project policy.
- ☐ Record branch name and commit SHA.
- ☐ Do not automatically merge.
- ☐ If validation fails, record the result and preserve the branch/logs for inspection.
### Done when
- ☐ Successful task ends with a pushed reviewable branch and recorded commit.
- ☐ Default branch is unchanged.
- ☐ Dirty-repository and failed-test behaviors are deterministic and tested.
## Phase 13 — Explicit Merge / Deploy Action Boundary
Objective: Prepare safe APIs without enabling arbitrary privileged execution.
### Tasks
- ☐ Define typed git.merge.requested and deploy.requested actions.
- ☐ Add policy states such as automatic, review, and explicit-confirmation.
- ☐ Default merge and production deploy to explicit-confirmation.
- ☐ Implement adapter interfaces only; actual production deployment adapters may remain unimplemented in MVP.
- ☐ Ensure a model cannot turn free-form text directly into a shell deployment command.
### Done when
- ☐ Merge/deploy requests can be represented and policy-checked.
- ☐ No production deployment can occur through arbitrary model output.
- ☐ MVP can ship with these actions disabled or review-only.
## Phase 14 — Admin UI: Activity
Objective: Create an operational console rather than another productivity inbox.
### Tasks
- ☐ Build Activity page showing incoming events chronologically.
- ☐ Display source, timestamp, original text/summary, classification, destination, and status.
- ☐ Build event detail page showing raw payload, normalized event, context used, classifier result, processing attempts, policy result, delivery attempts, and downstream ID.
- ☐ Add filters for source, status, action type, and date.
- ☐ Make failures/needs_review visually obvious without adding task/reminder management features.
### Done when
- ☐ A Pebble capture can be followed end-to-end from raw webhook through downstream result.
- ☐ No Tasks, Reminders, Notes, or Packages top-level product sections exist in the Hub.
## Phase 15 — Admin UI: Executions and Failures
Objective: Support focused inspection of coding agents and broken integrations.
### Tasks
- ☐ Build Executions list with status, project, task summary, executor/model, start time, duration, branch, and commit.
- ☐ Build execution detail page with request, generated wrapper prompt, stdout/stderr, validation result, branch, commit, and final agent response.
- ☐ Build Failures/dead-letter page for classification, delivery, and execution failures.
- ☐ Add manual retry controls with authorization.
### Done when
- ☐ One-off coding work can be inspected without opening Tim.
- ☐ Failed delivery or agent execution can be retried from the Hub.
## Phase 16 — Reclassification and Corrections
Objective: Allow the system to improve operationally without destroying historical evidence.
### Tasks
- ☐ Add a correction action from event detail.
- ☐ Allow selecting a replacement action type and editing structured fields.
- ☐ Preserve the original classification record.
- ☐ Create a new processing attempt for corrected dispatch.
- ☐ Add Reclassify action that invokes the current classifier again.
- ☐ Prevent accidental duplicate side effects by using a new attempt ID plus stable source history.
### Done when
- ☐ Operator can correct Note → Task and dispatch it to Mail.
- ☐ Original model classification remains visible.
- ☐ Audit history clearly shows correction and resulting action.
## Phase 17 — Reminder Delivery Ownership
Objective: Ensure reminders are scheduled and surfaced by Mail rather than by Relay.
### Tasks
- ☐ Define Mail reminder creation contract including text, remindAt, timezone, source event ID, and original time phrase.
- ☐ Do not implement user-facing reminder notification scheduling in the Hub.
- ☐ If Mail is not ready, implement only a temporary adapter/stub clearly marked as non-canonical.
- ☐ Record Mail's returned reminder ID.
### Done when
- ☐ Hub classification can create a reminder in Mail.
- ☐ The Hub does not need to be running at reminder trigger time for Mail-owned reminders to fire.
## Phase 18 — Observability and Operational Hardening
Objective: Make failures diagnosable in a long-running personal service.
### Tasks
- ☐ Add correlation IDs across webhook, classification, routing, delivery, and execution.
- ☐ Use structured logs everywhere.
- ☐ Add counters/timings for incoming events, classifier latency/failure, delivery retry counts, and execution outcomes.
- ☐ Optionally add OpenTelemetry instrumentation behind configuration.
- ☐ Add database backup guidance or an automated periodic SQLite backup mechanism appropriate for the deployment.
- ☐ Add log retention / execution-log size limits.
### Done when
- ☐ A single correlation ID can trace an event across the pipeline.
- ☐ Large logs cannot grow the database without bound.
- ☐ Operational backup procedure is documented and tested.
## Phase 19 — Network Deployment
Objective: Deploy with the intended security boundary using existing infrastructure.
### Tasks
- ☐ Bind public and internal listeners to appropriate local interfaces/ports.
- ☐ Configure Cloudflare Tunnel/Caddy so capture.example.com exposes only the public listener.
- ☐ Configure integrations.example.com for internal/admin access via Tailscale and/or Cloudflare Access.
- ☐ Verify no route leakage from internal listener to public hostname.
- ☐ Configure TLS/proxy headers correctly.
- ☐ Set request limits at the proxy as an additional layer.
- ☐ Document service startup/restart behavior.
### Done when
- ☐ External request can reach only the Pebble webhook surface.
- ☐ Admin UI/internal API is inaccessible through the public hostname.
- ☐ Internal/admin access works through the chosen trusted path.
## Phase 20 — End-to-End Acceptance Suite
Objective: Prove the complete system before considering the MVP complete.
### Tasks
- ☐ Add fixture for Pebble task capture → Mail task.
- ☐ Add fixture for Pebble reminder capture → Mail reminder.
- ☐ Add fixture for note capture → configured note owner.
- ☐ Add fixture for note continuation using recent context.
- ☐ Add fixture for Mail package.detected → OmniApp delivery.
- ☐ Add fixture for coding command → registered project → executor → branch/commit/push.
- ☐ Add fixture for classifier failure → needs_review.
- ☐ Add fixture for destination outage → retry → eventual success.
- ☐ Add fixture for duplicate source webhook.
- ☐ Add authorization tests across public/internal boundaries.
- ☐ Add regression test ensuring merge/deploy cannot be invoked by an unauthorized or malformed action.
### Done when
- ☐ All acceptance fixtures pass.
- ☐ Fresh install plus documented configuration can reproduce the environment.
- ☐ No critical path depends on manually editing the database.
## 21. Suggested Commit Sequence
1. chore: initialize integration hub
1. feat: add sqlite schema and durable job queue
1. feat: ingest pebble webhooks
1. feat: add structured voice classification
1. feat: add context-aware note continuation
1. feat: add integration routing and durable delivery
1. feat: add internal service API and auth
1. feat: add project registry
1. feat: add codex and claude executors
1. feat: add agent git branch workflow
1. feat: add admin activity and event detail UI
1. feat: add execution and failure UI
1. feat: add correction and retry workflows
1. chore: harden networking observability and end-to-end tests
## 22. Final MVP Exit Criteria
- ☐ Pebble can send a transcription to one public endpoint.
- ☐ The raw payload is durably persisted before interpretation.
- ☐ The Hub classifies task, reminder, note, continuation, command, and unknown with schema validation.
- ☐ Tasks/reminders are delivered to Mail, not managed in the Hub.
- ☐ Structured cross-app events can route to OmniApp.
- ☐ One-off coding work can run via Codex or Claude against only registered projects.
- ☐ Coding work creates and pushes a reviewable branch without auto-merging.
- ☐ Every important pipeline stage is inspectable from the admin UI.
- ☐ Failures are retried or surfaced; no input disappears silently.
- ☐ Public and internal network surfaces are isolated.
- ☐ All critical operations have automated tests and an end-to-end acceptance path.

---

## Reference Tables

> Operating rule: Work through phases in order. Do not invent new product behavior when a requirement is ambiguous; prefer the simplest implementation that preserves the architecture. Commit at the end of each phase with tests passing.
