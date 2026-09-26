<script lang="ts">
  import ActivityView from "$lib/components/ActivityView.svelte";
  import { getActivityView } from "$lib/activity.remote";
  import type { ActivityStatus } from "$lib/server/activity";

  let source = $state("");
  let status = $state("");
  let actionType = $state("");
  let from = $state("");
  let to = $state("");

  const activity = $derived(
    await getActivityView({
      source: source || undefined,
      status: (status || undefined) as ActivityStatus | undefined,
      actionType: actionType || undefined,
      from: from || undefined,
      to: to || undefined,
    })
  );
</script>

<svelte:head>
  <title>Activity · Relay</title>
  <meta
    name="description"
    content="Internal event activity and delivery status for Relay."
  />
</svelte:head>

<ActivityView
  events={activity.events}
  options={activity.options}
  bind:source
  bind:status
  bind:actionType
  bind:from
  bind:to
/>
