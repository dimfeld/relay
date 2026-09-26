<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Registered projects | Relay</title>
</svelte:head>

<main>
  <h1>Registered projects</h1>
  <p><a href="/">Relay home</a></p>

  {#if data.projects.length === 0}
    <p>No projects are registered.</p>
  {:else}
    <ul>
      {#each data.projects as project (project.id)}
        <li>
          <h2>{project.name}</h2>
          <dl>
            <dt>ID</dt>
            <dd>{project.id}</dd>
            <dt>Aliases</dt>
            <dd>{project.aliases.length ? project.aliases.join(", ") : "None"}</dd>
            <dt>Directory</dt>
            <dd><code>{project.directory}</code></dd>
            <dt>Default branch</dt>
            <dd>{project.defaultBranch}</dd>
            <dt>Allowed agents</dt>
            <dd>{project.allowedAgents.join(", ")}</dd>
            <dt>Instructions</dt>
            <dd>{project.instructions ?? "None"}</dd>
            <dt>Push</dt>
            <dd>{project.policy.allowPush ? "Allowed" : "Blocked"}</dd>
            <dt>Merge</dt>
            <dd>{project.policy.allowMerge ? "Allowed" : "Blocked"}</dd>
            <dt>Deploy</dt>
            <dd>{project.policy.allowDeploy ? "Allowed" : "Blocked"}</dd>
          </dl>
        </li>
      {/each}
    </ul>
  {/if}
</main>
