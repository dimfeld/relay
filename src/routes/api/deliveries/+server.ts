import { getServerContext } from "$lib/server/context";
import { handleAdminRead, loadDeliveries } from "$lib/server/api/admin";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request }) =>
  handleAdminRead(getServerContext(), request, loadDeliveries);
