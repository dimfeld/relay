import { getServerContext } from "$lib/server/context";
import { handleAdminRead, loadDelivery } from "$lib/server/api/admin";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request, params }) =>
  handleAdminRead(getServerContext(), request, loadDelivery(params.id));
