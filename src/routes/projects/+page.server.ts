import { getServerContext } from "$lib/server/context";
import { listProjectCatalog } from "$lib/server/projects/catalog";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => ({
  projects: listProjectCatalog(getServerContext().db),
});
