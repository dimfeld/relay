import type { Database } from "bun:sqlite";
import { listProjectCatalog } from "./catalog";
import type { RegisteredProject } from "../classifier/types";

/** Enabled projects with the aliases stored in their config. */
export function listRegisteredProjects(db: Database): RegisteredProject[] {
  return listProjectCatalog(db).map(({ id, name, aliases }) => ({ id, name, aliases }));
}
