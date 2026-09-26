import { command, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { getServerContext } from "$lib/server/context";
import { AdminActionError } from "$lib/server/admin-error";
import { listFailures, retryClassification, retryDelivery } from "$lib/server/failures";

export const getFailuresView = query(() => listFailures(getServerContext().db));

async function runRetry(retry: () => unknown): Promise<void> {
  try {
    retry();
  } catch (cause) {
    if (cause instanceof AdminActionError) error(cause.status, cause.message);
    throw cause;
  }
  await getFailuresView().refresh();
}

export const retryFailedClassification = command(z.string(), (eventId) =>
  runRetry(() => retryClassification(getServerContext().db, eventId))
);

export const retryFailedDelivery = command(z.string(), (deliveryId) =>
  runRetry(() => retryDelivery(getServerContext().db, deliveryId))
);
