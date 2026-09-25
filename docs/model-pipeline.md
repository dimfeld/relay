# Model Pipeline

This document defines how Relay uses models for incoming events. Keep each call behind a server module so routes and workers do not depend on a provider SDK.

## Model roles

1. Persist the original input and normalize its text before a model call.
2. Apply exact signals, such as a wake name or a registered project alias, in TypeScript.
3. Use TypeSafe AI Jev to select one action type: `task.create`, `reminder.create`, `note.create`, `note.append`, `command.execute`, or `unknown`. Send the normalized text and selected recent context as Jev state. Use Jev's `choice` question with explicit options. Map the selected option to the action type in TypeScript.
4. If Jev selects `unknown`, record the result without an extraction call. For other types, use GPT-6 Luna through the Vercel AI SDK to extract only the fields for the selected type. Luna must not change Jev's selected type.
5. Validate the extracted fields with that type's Zod schema. Resolve references, routes, and permissions in TypeScript before any side effect.

Use the official [`@typesafe-ai/sdk`](https://github.com/typesafe-ai/typesafe-sdk-js) package for Jev. Its `TypeSafeClient.systemOne` call accepts state and typed questions; a `choice` answer contains the selected option. Use the [`ai` and `@ai-sdk/openai` packages](https://ai-sdk.dev/providers/ai-sdk-providers/openai) for Luna. The OpenAI provider uses the Responses API by default. Use [`generateText` with `Output.object({ schema })`](https://ai-sdk.dev/docs/reference/ai-sdk-core/output) for schema checked extraction. The OpenAI model ID is [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna).

Keep the Jev and Luna clients in separate adapters. The classifier service coordinates them and returns a validated action or a recorded failure. Do not call Luna for action selection. Do not ask Jev to produce dates, titles, note text, project paths, or commands.

## Configuration

Extend the Phase 1 configuration loader when this pipeline is implemented. Require `TYPESAFE_API_KEY` and `OPENAI_API_KEY` for the worker that runs classification. Configure the Jev model as `jev-latest` and the extraction model as `gpt-6-luna`. Keep model IDs in configuration so an operator can change a deployment without changing code. Do not expose keys to the browser, public listener, logs, or event records. The current `MODEL_PROVIDER` and `MODEL_NAME` placeholders do not yet implement this pipeline.

## Extraction rules

- Define a Zod schema for each action's fields. Construct the final action from the fixed Jev type and the validated fields.
- Give Luna the normalized text, only the selected context, the fixed action type, and the field schema. Keep the original text in the event record.
- Extract reminder time, time zone, and original time phrase when the action needs them. If a required time cannot be resolved, record `needs_review`.
- Resolve `note.append` targets from recorded context and known downstream IDs. If the target is unclear, record `needs_review` or create a new note only when the input supports that action.
- For coding requests, extract a project name or alias and a task description. Resolve the project against the registry. The model must not supply an executable, working directory, shell command, Git command, merge command, deployment command, or arbitrary CLI flag.
- Treat Jev's typed output as a valid label, not proof that the label is correct. Record its available probabilities and confidence for inspection. Use explicit policy and validation to decide whether dispatch is safe; do not infer a confidence threshold from the model response.

If Jev fails, keep the event and record the failed attempt for retry or review. If Luna returns no valid object, retry once with a repair request or mark `needs_review`. If the repair fails, mark `needs_review`. Each retry and reclassification creates a new processing attempt. No model failure may discard the original input or start a side effect.

Record the provider, model ID, latency, and available usage for each call. Record the selected label, selected context IDs, validated action, and short operational reason. Do not save hidden reasoning or credentials.

## Other model and agent work

Use GPT-6 Luna through the Vercel AI SDK for other in-process language tasks that Relay adds, such as schema checked field repair or an operational summary. Each such task needs a defined output schema and a clear failure state. TypeScript still owns routing, policy, authorization, and side effects. Do not use Luna as a coding agent or as a model inside coding agent execution.

Codex and Claude remain separate `AgentExecutor` implementations for coding work. The intake pipeline may classify an incoming command and extract its request fields before execution. After intake, the chosen executor owns the coding task under the registered project policy. Luna does not plan, write, review, or run code, and it does not choose a process command or bypass executor configuration. Record both the requested executor/model and the executor/model that ran.

## Tests for the classification phase

Use fake Jev and Luna adapters in unit tests. Cover every action label, valid field extraction, invalid fields, unavailable providers, a mismatched Luna action type, uncertain note targets, and a coding request with an unregistered project. Test that no invalid result reaches dispatch. Keep a separate opt-in integration check for the real providers when credentials are available.
