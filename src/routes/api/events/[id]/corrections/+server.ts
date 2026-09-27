import { getServerContext } from "$lib/server/context";
import { handleAdminAction } from "$lib/server/api/admin";
import { correctClassification, readCorrectionInput } from "$lib/server/corrections";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request, params }) => {
  const context = getServerContext();
  return handleAdminAction(context, request, async (db, identity) => {
    const input = readCorrectionInput(await request.json().catch(() => null));
    return correctClassification(db, context.routing, params.id, input, identity.name);
  });
};
