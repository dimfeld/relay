import { command, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { AdminActionError } from "$lib/server/admin-error";
import { getEventDetail } from "$lib/server/event-detail";
import {
  correctClassification,
  correctionInputSchema,
  reclassifyEvent,
} from "$lib/server/corrections";
import { getServerContext } from "$lib/server/context";
import { z } from "zod";

/** The internal admin UI has no signed-in user, so its actions are recorded under this name. */
const ADMIN_UI_OPERATOR = "admin UI";

export const getEventDetailView = query(z.string(), (eventId) => {
  const { db } = getServerContext();
  return getEventDetail(db, eventId);
});

async function runAction(eventId: string, action: () => unknown): Promise<void> {
  try {
    await action();
  } catch (cause) {
    if (cause instanceof AdminActionError) error(cause.status, cause.message);
    throw cause;
  }
  await getEventDetailView(eventId).refresh();
}

export const correctEventClassification = command(
  z.object({ eventId: z.string(), correction: correctionInputSchema }),
  ({ eventId, correction }) =>
    runAction(eventId, () => {
      const { db, routing } = getServerContext();
      return correctClassification(db, routing, eventId, correction, ADMIN_UI_OPERATOR);
    })
);

export const reclassifyEventClassification = command(z.string(), (eventId) =>
  runAction(eventId, () => reclassifyEvent(getServerContext().db, eventId, ADMIN_UI_OPERATOR))
);
