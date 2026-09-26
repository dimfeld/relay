import { getServerContext } from "$lib/server/context";
import { handleAdminAction } from "$lib/server/api/admin";
import { reclassifyEvent } from "$lib/server/corrections";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request, params }) =>
  handleAdminAction(getServerContext(), request, (db, identity) => ({
    job: reclassifyEvent(db, params.id, identity.name),
  }));
