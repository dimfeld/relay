import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const projectAgentSchema = z.enum(["codex", "claude"]);

export const projectPolicySchema = z.object({
  allowPush: z.boolean().default(true),
  allowMerge: z.boolean().default(false),
  allowDeploy: z.boolean().default(false),
});

const projectDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).default([]),
  directory: z.string().trim().min(1),
  defaultBranch: z.string().trim().min(1),
  allowedAgents: z.array(projectAgentSchema).min(1),
  instructions: z.string().optional(),
  policy: projectPolicySchema.default({ allowPush: true, allowMerge: false, allowDeploy: false }),
});

const projectsFileSchema = z.object({
  projects: z.array(projectDefinitionSchema),
});

export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;
export type ProjectAgent = z.infer<typeof projectAgentSchema>;

/** Read and validate the optional project file. Return null when it is not configured. */
export function loadProjectDefinitions(filePath: string | undefined): ProjectDefinition[] | null {
  if (!filePath) return null;

  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read project configuration at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Could not parse project configuration at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = projectsFileSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const location = issue.path.length ? issue.path.join(".") : "projects";
      return `${location}: ${issue.message}`;
    });
    throw new Error(`Invalid project configuration at ${filePath}:\n${problems.join("\n")}`);
  }

  validateProjectSelectors(parsed.data.projects, filePath);
  for (const project of parsed.data.projects) validateProjectDirectory(project, filePath);
  return parsed.data.projects;
}

function validateProjectSelectors(projects: ProjectDefinition[], filePath: string): void {
  const selectors = new Map<string, ProjectDefinition>();
  for (const project of projects) {
    for (const selector of [project.id, project.name, ...project.aliases]) {
      const key = selector.toLowerCase();
      const owner = selectors.get(key);
      if (owner && owner.id !== project.id) {
        throw new Error(
          `Invalid project configuration at ${filePath}: selector "${selector}" is shared by ${owner.name} and ${project.name}.`
        );
      }
      selectors.set(key, project);
    }
  }
}

function validateProjectDirectory(project: ProjectDefinition, filePath: string): void {
  if (!isAbsolute(project.directory)) {
    throw new Error(
      `Invalid project configuration at ${filePath}: project ${project.name} directory must be an absolute path.`
    );
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(project.directory);
  } catch {
    throw new Error(
      `Invalid project configuration at ${filePath}: directory for ${project.name} does not exist: ${project.directory}`
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Invalid project configuration at ${filePath}: directory for ${project.name} is not a directory: ${project.directory}`
    );
  }
}
