import { getServerContext } from "$lib/server/context";
import { handleAdminAction } from "$lib/server/api/admin";
import { correctClassification, readCorrectionInput } from "$lib/server/corrections";
import { createRoutingService } from "$lib/server/routing/service";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request, params }) =>
  handleAdminAction(getServerContext(), request, async (db, identity) => {
    const input = readCorrectionInput(await request.json().catch(() => null));
    return correctClassification(db, createRoutingService({ db }), params.id, input, identity.name);
  });
