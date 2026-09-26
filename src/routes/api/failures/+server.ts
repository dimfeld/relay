import { getServerContext } from "$lib/server/context";
import { handleAdminRead, loadFailures } from "$lib/server/api/admin";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request }) =>
  handleAdminRead(getServerContext(), request, loadFailures);
