<script lang="ts">
  import { error } from "@sveltejs/kit";
  import { page } from "$app/state";
  import EventDetailView from "$lib/components/EventDetailView.svelte";
  import { getEventDetailView } from "$lib/event-detail.remote";

  const detail = $derived(
    (await getEventDetailView(page.params.eventId)) ?? error(404, "Event not found")
  );
</script>

<svelte:head>
  <title>Event detail · Relay</title>
  <meta name="description" content="Read-only processing history for a Relay event." />
</svelte:head>

<EventDetailView {detail} />
