<script lang="ts">
  import { error } from "@sveltejs/kit";
  import { page } from "$app/state";
  import EventDetailView from "$lib/components/EventDetailView.svelte";
  import {
    correctEventClassification,
    getEventDetailView,
    reclassifyEventClassification,
  } from "$lib/event-detail.remote";

  const detail = $derived(
    (await getEventDetailView(page.params.eventId)) ?? error(404, "Event not found")
  );
</script>

<svelte:head>
  <title>Event detail · Relay</title>
  <meta
    name="description"
    content="Processing history for a Relay event, with correction and reclassification actions."
  />
</svelte:head>

<EventDetailView
  {detail}
  correct={(correction) =>
    correctEventClassification({ eventId: page.params.eventId, correction })}
  reclassify={() => reclassifyEventClassification(page.params.eventId)}
/>
