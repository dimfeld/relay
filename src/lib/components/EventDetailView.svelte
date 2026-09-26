<script lang="ts">
  import type { EventDetail } from "../server/event-detail";

  let { detail }: { detail: EventDetail } = $props();

  function pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
</script>

<main>
  <header class="page-header">
    <a class="back-link" href="/activity">← Activity</a>
    <p class="eyebrow">{detail.event.source} · {detail.event.receivedAt}</p>
    <h1>Event detail</h1>
    <p class="event-id">{detail.event.id}</p>
  </header>

  {#if detail.failedStep}
    <aside class="failure-summary" role="alert">
      <strong>Failed at {detail.failedStep.step}</strong>
      <p>{detail.failedStep.reason}</p>
    </aside>
  {/if}

  <section aria-labelledby="raw-input-title">
    <h2 id="raw-input-title">Raw input</h2>
    <p>Original event payload received from {detail.event.source}.</p>
    <pre>{pretty(detail.event.payload)}</pre>
  </section>

  <section aria-labelledby="normalized-event-title">
    <h2 id="normalized-event-title">Normalized event</h2>
    <pre>{pretty(detail.normalizedEvent)}</pre>
  </section>

  <section aria-labelledby="context-title">
    <h2 id="context-title">Selected context</h2>
    {#each detail.contexts as context (context.attemptId)}
      <div class="record">
        <h3>Classification attempt {context.attemptId}</h3>
        {#each context.items as item (item.eventId)}
          <article class="context-item">
            <strong>{item.source} · {item.receivedAt}</strong>
            <p>{item.summary}</p>
            <small>Event {item.eventId}</small>
          </article>
        {/each}
        {#each context.unresolvedIds as id (id)}
          <p class="muted">Context event {id} is not available in the event store.</p>
        {/each}
        {#if context.items.length === 0 && context.unresolvedIds.length === 0}
          <p class="muted">No context events were selected for this attempt.</p>
        {/if}
      </div>
    {:else}
      <p class="muted">No selected context was recorded.</p>
    {/each}
  </section>

  <section aria-labelledby="classification-title">
    <h2 id="classification-title">Classification</h2>
    {#each detail.classifications as classification (classification.id)}
      <article class="record">
        <div class="record-heading">
          <h3>{classification.actionType}</h3>
          <span class="status-badge" class:problem={classification.status !== "classified"}>
            {classification.status.replaceAll("_", " ")}
          </span>
        </div>
        <p>{classification.provider} · {classification.model} · {classification.createdAt}</p>
        <small>Classification {classification.id}</small>
        {#if classification.confidence !== null}
          <p>{Math.round(classification.confidence * 100)}% confidence</p>
        {/if}
        {#if classification.error}
          <p class="error-text">{classification.error}</p>
        {/if}
        <pre>{pretty(classification.result)}</pre>
      </article>
    {:else}
      <p class="muted">No classification result was recorded.</p>
    {/each}
  </section>

  <section aria-labelledby="attempts-title">
    <h2 id="attempts-title">Processing attempts</h2>
    {#each detail.attempts as attempt (attempt.id)}
      <article class="record">
        <div class="record-heading">
          <h3>{attempt.stage}</h3>
          <span class="status-badge" class:problem={attempt.status === "failed" || attempt.status === "needs_review"}>
            {attempt.status.replaceAll("_", " ")}
          </span>
        </div>
        <small>Attempt {attempt.id}</small>
        <p>{attempt.startedAt}{attempt.finishedAt ? ` – ${attempt.finishedAt}` : ""}</p>
        {#if attempt.error}
          <p class="error-text">{attempt.error}</p>
        {/if}
        {#if attempt.details}
          <pre>{pretty(attempt.details)}</pre>
        {/if}
      </article>
    {:else}
      <p class="muted">No processing attempts were recorded.</p>
    {/each}
  </section>

  <section aria-labelledby="policy-title">
    <h2 id="policy-title">Policy result</h2>
    <p class="muted">No separate policy decision is recorded.</p>
    {#each detail.actionResults as result (result.id)}
      <article class="record">
        <div class="record-heading">
          <h3>{result.actionType}</h3>
          <span class="status-badge" class:problem={result.status === "failed" || result.status === "unrouted"}>
            {result.status.replaceAll("_", " ")}
          </span>
        </div>
        <small>Action result {result.id}</small>
        <p>{result.createdAt}</p>
        {#if result.error}
          <p class="error-text">{result.error}</p>
        {/if}
        {#if result.result}
          <pre>{pretty(result.result)}</pre>
        {/if}
      </article>
    {:else}
      <p class="muted">No action result was recorded.</p>
    {/each}
  </section>

  <section aria-labelledby="routes-title">
    <h2 id="routes-title">Selected route</h2>
    {#each detail.routes as selected (selected.deliveryId)}
      <article class="record">
        <h3>{selected.integration?.name ?? "Unknown destination"}</h3>
        {#if selected.route}
          <p>Route {selected.route.id}</p>
          <p>Event type: {selected.route.eventType ?? "Any"}</p>
          <p>Action type: {selected.route.actionType ?? "Any"}</p>
        {:else}
          <p class="muted">The selected route record is no longer available.</p>
        {/if}
        <small>Delivery {selected.deliveryId}</small>
      </article>
    {:else}
      <p class="muted">No route was selected.</p>
    {/each}
  </section>

  <section aria-labelledby="deliveries-title">
    <h2 id="deliveries-title">Delivery attempts</h2>
    {#each detail.deliveries as record (record.delivery.id)}
      <article class="record">
        <div class="record-heading">
          <h3>{record.delivery.id}</h3>
          <span class="status-badge" class:problem={record.delivery.status === "failed" || record.delivery.status === "dead"}>
            {record.delivery.status}
          </span>
        </div>
        <p>{record.delivery.attempts} attempts · {record.delivery.updatedAt}</p>
        {#if record.downstreamId}
          <p>Downstream ID: <strong>{record.downstreamId}</strong></p>
        {/if}
        {#if record.delivery.lastError}
          <p class="error-text">{record.delivery.lastError}</p>
        {/if}
        <h4>Request</h4>
        <pre>{pretty(record.delivery.request)}</pre>
        {#if record.delivery.response}
          <h4>Response</h4>
          <pre>{pretty(record.delivery.response)}</pre>
        {/if}
      </article>
    {:else}
      <p class="muted">No delivery was recorded.</p>
    {/each}
  </section>

  <section aria-labelledby="downstream-title">
    <h2 id="downstream-title">Downstream object ID</h2>
    {#each detail.deliveries.filter((record) => record.downstreamId) as record (record.delivery.id)}
      <p><strong>{record.downstreamId}</strong> from delivery {record.delivery.id}</p>
    {:else}
      <p class="muted">No downstream object ID was recorded.</p>
    {/each}
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f5f7fa;
    color: #1d2939;
    font-family: system-ui, sans-serif;
  }

  main {
    margin: 0 auto;
    max-width: 1000px;
    padding: 40px 32px 64px;
  }

  .page-header {
    margin-bottom: 24px;
  }

  .back-link {
    color: #475467;
    text-decoration: none;
  }

  .eyebrow,
  .event-id,
  .muted {
    color: #667085;
  }

  .eyebrow {
    margin: 26px 0 4px;
    font-size: 13px;
  }

  h1 {
    margin: 0;
    font-size: 32px;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 20px;
  }

  h3,
  h4 {
    margin: 0;
  }

  section,
  .failure-summary {
    margin-top: 18px;
    padding: 20px;
    border: 1px solid #e4e7ec;
    border-radius: 10px;
    background: #fff;
  }

  .failure-summary {
    border-color: #fda29b;
    background: #fff1f0;
    color: #912018;
  }

  .failure-summary p {
    margin: 7px 0 0;
  }

  .record {
    margin-top: 12px;
    padding: 16px;
    border: 1px solid #eaecf0;
    border-radius: 8px;
  }

  .record-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .context-item {
    margin-top: 12px;
    padding: 12px;
    border-left: 3px solid #98a2b3;
    background: #f9fafb;
  }

  .context-item p {
    margin: 6px 0;
    white-space: pre-wrap;
  }

  .context-item small,
  .record small {
    color: #667085;
  }

  p {
    overflow-wrap: anywhere;
  }

  pre {
    overflow: auto;
    margin: 12px 0 0;
    padding: 14px;
    border-radius: 6px;
    background: #f2f4f7;
    color: #344054;
    font: 13px/1.5 ui-monospace, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .status-badge {
    display: inline-block;
    padding: 4px 8px;
    border-radius: 999px;
    background: #eef4ff;
    color: #3538cd;
    font-size: 12px;
    font-weight: 600;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .status-badge.problem {
    background: #fee4e2;
    color: #b42318;
  }

  .error-text {
    color: #b42318;
  }

  @media (max-width: 700px) {
    main {
      padding: 24px 16px 40px;
    }

    section {
      padding: 16px;
    }
  }
</style>
