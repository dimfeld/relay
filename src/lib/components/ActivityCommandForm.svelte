<script lang="ts">
  import {
    submitActivityCommandForm,
    type ActivityCommandFormState,
    type ActivityCommandSubmission,
  } from "$lib/activity-command";

  interface Props {
    state: ActivityCommandFormState;
    submitCommand: (input: ActivityCommandSubmission) => Promise<string>;
    refreshActivity: () => Promise<unknown>;
  }

  let { state, submitCommand, refreshActivity }: Props = $props();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await submitActivityCommandForm(state, submitCommand, refreshActivity);
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
    <button type="submit" disabled={state.pending}>
      {state.pending ? "Submitting…" : "Submit command"}
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

  .submission-error {
    margin: 12px 0 0;
    color: #b42318;
  }

  .submission-success {
    margin: 12px 0 0;
  }
</style>
