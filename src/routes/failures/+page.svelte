<script lang="ts">
  import FailuresView, { type RetryTarget } from "$lib/components/FailuresView.svelte";
  import {
    getFailuresView,
    retryFailedClassification,
    retryFailedDelivery,
  } from "$lib/failures.remote";

  const failures = $derived(await getFailuresView());

  function retry(target: RetryTarget) {
    return target.kind === "classification"
      ? retryFailedClassification(target.id)
      : retryFailedDelivery(target.id);
  }
</script>

<svelte:head>
  <title>Failures · Relay</title>
  <meta
    name="description"
    content="Failed classifications and dead deliveries in Relay, with retry controls."
  />
</svelte:head>

<FailuresView {failures} {retry} />
