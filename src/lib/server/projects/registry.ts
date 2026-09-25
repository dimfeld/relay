import type { Database } from "bun:sqlite";
import { z } from "zod";
import { listProjects } from "../db/repositories/projects";
import type { RegisteredProject } from "../classifier/types";

const projectConfig = z.object({ aliases: z.array(z.string().trim().min(1)).default([]) });

/** Enabled projects with the aliases stored in their config. */
export function listRegisteredProjects(db: Database): RegisteredProject[] {
  return listProjects(db)
    .filter((project) => project.enabled)
    .map((project) => ({
      id: project.id,
      name: project.name,
      aliases: projectConfig.safeParse(project.config).data?.aliases ?? [],
    }));
}
