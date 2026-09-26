import { getServerContext } from "$lib/server/context";
import { handleAdminRetry } from "$lib/server/api/admin";
import { retryClassification } from "$lib/server/failures";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request, params }) =>
  handleAdminRetry(getServerContext(), request, (db) => ({
    job: retryClassification(db, params.id),
  }));
