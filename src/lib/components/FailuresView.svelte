<script module lang="ts">
  export interface RetryTarget {
    kind: "classification" | "delivery";
    /** The event ID for a classification, or the delivery ID for a delivery. */
    id: string;
  }
</script>

<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import type { FailureList } from "../server/failures";

  interface Props {
    failures: FailureList;
    retry: (target: RetryTarget) => Promise<unknown>;
  }

  let { failures, retry }: Props = $props();

  let pending = $state<string | null>(null);
  let retryError = $state<string | null>(null);

  async function runRetry(target: RetryTarget) {
    pending = `${target.kind}:${target.id}`;
    retryError = null;
    try {
      await retry(target);
    } catch (error) {
      retryError = isHttpError(error)
        ? error.body.message
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      pending = null;
    }
  }
</script>

<main>
  <header class="page-header">
    <a class="back-link" href="/activity">← Activity</a>
    <h1>Failures</h1>
    <p>Failed classifications and dead deliveries. A retry sends the item through its queue again.</p>
  </header>

  {#if retryError}
    <p class="retry-error" role="alert">Retry failed: {retryError}</p>
  {/if}

  <section aria-labelledby="classification-failures">
    <h2 id="classification-failures">Classification failures</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Source</th>
            <th scope="col">Event type</th>
            <th scope="col">Attempts</th>
            <th scope="col">Last error</th>
            <th scope="col">Failed at</th>
            <th scope="col"><span class="visually-hidden">Retry</span></th>
          </tr>
        </thead>
        <tbody>
          {#each failures.classifications as failure (failure.jobId)}
            <tr>
              <td class="id">
                <a href={`/activity/${encodeURIComponent(failure.eventId)}`}>{failure.eventId}</a>
              </td>
              <td>{failure.source}</td>
              <td>{failure.eventType}</td>
              <td>{failure.attempts}</td>
              <td class="error-text">{failure.lastError ?? "—"}</td>
              <td><time datetime={failure.failedAt}>{failure.failedAt}</time></td>
              <td>
                <button
                  type="button"
                  disabled={pending !== null}
                  onclick={() => runRetry({ kind: "classification", id: failure.eventId })}
                >
                  {pending === `classification:${failure.eventId}` ? "Retrying…" : "Retry"}
                </button>
              </td>
            </tr>
          {:else}
            <tr>
              <td class="empty-state" colspan="7">No failed classifications.</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section aria-labelledby="delivery-failures">
    <h2 id="delivery-failures">Delivery failures</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Source</th>
            <th scope="col">Action type</th>
            <th scope="col">Destination</th>
            <th scope="col">Attempts</th>
            <th scope="col">Last error</th>
            <th scope="col">Failed at</th>
            <th scope="col"><span class="visually-hidden">Retry</span></th>
          </tr>
        </thead>
        <tbody>
          {#each failures.deliveries as failure (failure.deliveryId)}
            <tr>
              <td class="id">
                <a href={`/activity/${encodeURIComponent(failure.eventId)}`}>{failure.eventId}</a>
              </td>
              <td>{failure.source}</td>
              <td>{failure.actionType ?? "—"}</td>
              <td>{failure.destination}</td>
              <td>{failure.attempts}</td>
              <td class="error-text">{failure.lastError ?? "—"}</td>
              <td><time datetime={failure.failedAt}>{failure.failedAt}</time></td>
              <td>
                <button
                  type="button"
                  disabled={pending !== null}
                  onclick={() => runRetry({ kind: "delivery", id: failure.deliveryId })}
                >
                  {pending === `delivery:${failure.deliveryId}` ? "Retrying…" : "Retry"}
                </button>
              </td>
            </tr>
          {:else}
            <tr>
              <td class="empty-state" colspan="8">No dead deliveries.</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
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
    max-width: 1440px;
    padding: 40px 32px 64px;
  }

  .page-header {
    margin-bottom: 28px;
  }

  .back-link {
    color: #475467;
    font-size: 14px;
    text-decoration: none;
  }

  h1 {
    margin: 16px 0 4px;
    font-size: 32px;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 20px;
  }

  .page-header p {
    color: #667085;
  }

  section {
    margin-top: 28px;
  }

  .table-scroll {
    overflow-x: auto;
    border: 1px solid #e4e7ec;
    border-radius: 10px;
    background: #fff;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    font-size: 14px;
  }

  th,
  td {
    padding: 15px 16px;
    border-bottom: 1px solid #eaecf0;
    vertical-align: top;
  }

  th {
    background: #f9fafb;
    color: #475467;
    font-size: 12px;
    font-weight: 600;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  .id {
    overflow-wrap: anywhere;
  }

  .error-text {
    max-width: 360px;
    color: #b42318;
    overflow-wrap: anywhere;
  }

  button {
    min-height: 34px;
    border: 1px solid #d0d5dd;
    border-radius: 6px;
    background: #fff;
    color: #1d2939;
    cursor: pointer;
    font: inherit;
    padding: 0 12px;
  }

  button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .retry-error {
    padding: 12px 16px;
    border: 1px solid #fda29b;
    border-radius: 8px;
    background: #fef3f2;
    color: #b42318;
  }

  .empty-state {
    padding: 40px;
    color: #667085;
    text-align: center;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    main {
      padding: 24px 16px 40px;
    }
  }
</style>
