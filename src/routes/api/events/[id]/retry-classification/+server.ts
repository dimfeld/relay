import { getServerContext } from "$lib/server/context";
import { handleAdminAction } from "$lib/server/api/admin";
import { retryClassification } from "$lib/server/failures";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request, params }) =>
  handleAdminAction(getServerContext(), request, (db) => ({
    job: retryClassification(db, params.id),
  }));
