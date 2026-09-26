<script lang="ts">
  import type {
    ActivityFilterOptions,
    ActivityRow,
    ActivityStatus,
  } from "../server/activity";

  interface Props {
    events: ActivityRow[];
    options: ActivityFilterOptions;
    source?: string;
    status?: string;
    actionType?: string;
    from?: string;
    to?: string;
  }

  let {
    events,
    options,
    source = $bindable(""),
    status = $bindable(""),
    actionType = $bindable(""),
    from = $bindable(""),
    to = $bindable(""),
  }: Props = $props();

  function statusLabel(value: ActivityStatus): string {
    return value.replaceAll("_", " ");
  }

  function clearFilters() {
    source = "";
    status = "";
    actionType = "";
    from = "";
    to = "";
  }
</script>

<main>
  <header class="page-header">
    <a class="back-link" href="/">Relay</a>
    <h1>Activity</h1>
    <p>Incoming events, classifications, and delivery status.</p>
  </header>

  <section aria-label="Activity filters" class="filters">
    <label>
      Source
      <select bind:value={source}>
        <option value="">All sources</option>
        {#each options.sources as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </label>

    <label>
      Status
      <select bind:value={status}>
        <option value="">All statuses</option>
        {#each options.statuses as option (option)}
          <option value={option}>{statusLabel(option)}</option>
        {/each}
      </select>
    </label>

    <label>
      Action type
      <select bind:value={actionType}>
        <option value="">All action types</option>
        {#each options.actionTypes as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </label>

    <label>
      From
      <input aria-label="From date" type="date" bind:value={from} />
    </label>

    <label>
      To
      <input aria-label="To date" type="date" bind:value={to} />
    </label>

    <button class="clear-button" type="button" onclick={clearFilters}>Clear filters</button>
  </section>

  <p class="result-count">{events.length} events</p>

  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Source</th>
          <th scope="col">Time</th>
          <th scope="col">Input summary</th>
          <th scope="col">Classification</th>
          <th scope="col">Destination</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {#each events as event (event.id)}
          <tr class:attention={event.highlight}>
            <td class="source">{event.source}</td>
            <td><time datetime={event.receivedAt}>{event.receivedAt}</time></td>
            <td class="summary">
              <a href={`/activity/${encodeURIComponent(event.id)}`}>{event.summary}</a>
            </td>
            <td>
              <span>{event.actionType}</span>
              {#if event.confidence !== null}
                <small>{Math.round(event.confidence * 100)}% confidence</small>
              {/if}
            </td>
            <td>
              {event.destination ?? (event.status === "unrouted" ? "Unrouted" : "—")}
              {#if event.routeId}
                <small>Route {event.routeId}</small>
              {/if}
            </td>
            <td>
              <span class="status-badge" class:problem={event.highlight}>
                {statusLabel(event.status)}
              </span>
              {#if event.error}
                <small class="error-text">{event.error}</small>
              {/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td class="empty-state" colspan="6">No events match these filters.</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
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

  .page-header p,
  .result-count {
    color: #667085;
  }

  .filters {
    display: flex;
    align-items: end;
    flex-wrap: wrap;
    gap: 12px;
    padding: 18px;
    border: 1px solid #e4e7ec;
    border-radius: 10px;
    background: #fff;
  }

  label {
    display: grid;
    gap: 6px;
    color: #475467;
    font-size: 12px;
    font-weight: 600;
  }

  select,
  input,
  button {
    min-height: 38px;
    border: 1px solid #d0d5dd;
    border-radius: 6px;
    background: #fff;
    color: #1d2939;
    font: inherit;
    padding: 0 10px;
  }

  select {
    min-width: 150px;
  }

  .clear-button {
    cursor: pointer;
  }

  .result-count {
    margin: 22px 0 10px;
    font-size: 13px;
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
    min-width: 110px;
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

  .source {
    font-weight: 600;
  }

  .summary {
    min-width: 220px;
    max-width: 440px;
    overflow-wrap: anywhere;
  }

  small {
    display: block;
    margin-top: 5px;
    color: #667085;
    font-size: 12px;
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

  tr.attention td {
    background: #fff8f7;
  }

  .error-text {
    max-width: 240px;
    color: #b42318;
  }

  .empty-state {
    padding: 40px;
    color: #667085;
    text-align: center;
  }

  @media (max-width: 700px) {
    main {
      padding: 24px 16px 40px;
    }
  }
</style>
