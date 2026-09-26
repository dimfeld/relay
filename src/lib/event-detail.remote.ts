import { query } from "$app/server";
import { getEventDetail } from "$lib/server/event-detail";
import { getServerContext } from "$lib/server/context";
import { z } from "zod";

export const getEventDetailView = query(z.string(), (eventId) => {
  const { db } = getServerContext();
  return getEventDetail(db, eventId);
});
