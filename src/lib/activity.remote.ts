import { query } from "$app/server";
import { z } from "zod";
import { ACTIVITY_STATUSES, getActivityFilterOptions, listActivity } from "$lib/server/activity";
import { getServerContext } from "$lib/server/context";

const activityFiltersSchema = z.object({
  source: z.string().optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  actionType: z.string().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const getActivityView = query(activityFiltersSchema, (filters) => {
  const { db } = getServerContext();
  return {
    events: listActivity(db, filters),
    options: getActivityFilterOptions(db),
  };
});
