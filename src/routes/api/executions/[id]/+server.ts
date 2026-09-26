import { getServerContext } from "$lib/server/context";
import { handleAdminRead, loadExecution } from "$lib/server/api/admin";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request, params }) =>
  handleAdminRead(getServerContext(), request, loadExecution(params.id));
