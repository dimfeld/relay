import { getServerContext } from "$lib/server/context";
import { handleAdminRead, loadProject } from "$lib/server/api/admin";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request, params }) =>
  handleAdminRead(getServerContext(), request, loadProject(params.id));
