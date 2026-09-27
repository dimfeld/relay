<script lang="ts">
  import {
    submitActivityCommandForm,
    type ActivityCommandFormState,
    type ActivityCommandSubmission,
  } from "$lib/activity-command";

  interface Props {
    state: ActivityCommandFormState;
    submitCommand: (input: ActivityCommandSubmission) => Promise<string>;
    testCommand?: (input: { text: string }) => Promise<import("$lib/server/events/preview").WebCommandPreview>;
    refreshActivity: () => Promise<unknown>;
  }

  let { state, submitCommand, testCommand, refreshActivity }: Props = $props();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await submitActivityCommandForm(state, submitCommand, refreshActivity, testCommand);
  }
</script>

<section aria-label="Submit a command" class="command-entry">
  <h2>Submit a command</h2>
  <p>Enter a natural-language request for Relay to classify and process.</p>

  <form onsubmit={submit}>
    <label for="command-text">Command</label>
    <textarea
      id="command-text"
      bind:value={state.text}
      rows="3"
      required
      disabled={state.pending}
    ></textarea>
    <label class="test-mode"><input type="checkbox" bind:checked={state.testMode} disabled={state.pending} /> Test mode (show results without taking action)</label>
    <button type="submit" disabled={state.pending}>
      {state.pending ? (state.testMode ? "Testing…" : "Submitting…") : (state.testMode ? "Test command" : "Submit command")}
    </button>
  </form>

  {#if state.error}
    <p class="submission-error" role="alert">{state.error}</p>
  {/if}

  {#if state.eventId}
    <p class="submission-success" role="status">
      Command submitted. <a href={`/activity/${encodeURIComponent(state.eventId)}`}>View event</a>
    </p>
  {/if}

  {#if state.preview}
    <section class="preview" aria-label="Test result" role="status">
      <h3>Test result</h3>
      <p>No action was taken. No event was saved.</p>
      <dl>
        <dt>Status</dt><dd>{state.preview.status.replaceAll("_", " ")}</dd>
        <dt>Classification</dt><dd>{state.preview.status === "classified" ? state.preview.action.type : state.preview.status === "needs_review" ? state.preview.actionType : "Failed"}</dd>
        {#if state.preview.record.jev?.confidence !== null && state.preview.record.jev?.confidence !== undefined}
          <dt>Confidence</dt><dd>{Math.round(state.preview.record.jev.confidence * 100)}%</dd>
        {/if}
        <dt>Reason</dt><dd>{state.preview.record.reason}</dd>
        {#if state.preview.status === "failed"}
          <dt>Error</dt><dd>{state.preview.error}</dd>
        {/if}
        <dt>Destination</dt><dd>{state.preview.route ? `${state.preview.route.integrationName} (route ${state.preview.route.id})` : "No action would be delivered"}</dd>
      </dl>
      {#if state.preview.status === "classified"}
        <h4>Proposed action</h4>
        <pre>{JSON.stringify(state.preview.action, null, 2)}</pre>
      {/if}
      <details>
        <summary>Classification and extraction details</summary>
        <pre>{JSON.stringify(state.preview.record, null, 2)}</pre>
      </details>
    </section>
  {/if}
</section>

<style>
  .command-entry {
    margin: 0 0 24px;
    padding: 20px;
    border: 1px solid #e4e7ec;
    border-radius: 10px;
    background: #fff;
  }

  h2 {
    margin: 0 0 4px;
    font-size: 18px;
  }

  p {
    margin: 0 0 14px;
    color: #667085;
    font-size: 14px;
  }

  form {
    display: grid;
    justify-items: start;
    gap: 8px;
  }

  label {
    color: #475467;
    font-size: 13px;
    font-weight: 600;
  }

  textarea {
    box-sizing: border-box;
    width: min(100%, 760px);
    min-height: 84px;
    padding: 10px;
    border: 1px solid #d0d5dd;
    border-radius: 6px;
    color: #1d2939;
    font: inherit;
    resize: vertical;
  }

  button {
    min-height: 38px;
    padding: 0 14px;
    border: 0;
    border-radius: 6px;
    background: #175cd3;
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .test-mode {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .preview {
    margin-top: 16px;
    border-top: 1px solid #e4e7ec;
    padding-top: 16px;
  }

  .preview dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 16px;
  }

  .preview dd {
    margin: 0;
  }

  .preview pre {
    max-width: 100%;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .submission-error {
    margin: 12px 0 0;
    color: #b42318;
  }

  .submission-success {
    margin: 12px 0 0;
  }
</style>
