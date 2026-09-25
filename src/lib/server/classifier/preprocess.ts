import type { ExecutorProvider, RegisteredProject } from "./types";

export interface ProjectHint {
  projectId: string;
  projectName: string;
  matched: string;
}

/** Exact signals found in TypeScript before any model call. */
export interface Signals {
  wakeNameDetected: boolean;
  projectHints: ProjectHint[];
  executorMentions: ExecutorProvider[];
}

export interface PreprocessedInput {
  text: string;
  signals: Signals;
}

export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = normalizeText(phrase);
  if (!normalized) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalized)}($|[^\\p{L}\\p{N}])`, "iu").test(
    text
  );
}

export function detectWakeName(text: string, wakeName: string | undefined): boolean {
  if (!wakeName) return false;
  const normalized = normalizeText(wakeName);
  return new RegExp(`^(hey\\s+)?${escapeRegExp(normalized)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function findProjectHints(text: string, projects: RegisteredProject[]): ProjectHint[] {
  const hints: ProjectHint[] = [];
  for (const project of projects) {
    const matched = [project.name, ...project.aliases].find((name) => containsPhrase(text, name));
    if (matched) hints.push({ projectId: project.id, projectName: project.name, matched });
  }
  return hints;
}

export function preprocess(
  rawText: string,
  { wakeName, projects }: { wakeName?: string; projects: RegisteredProject[] }
): PreprocessedInput {
  const text = normalizeText(rawText);
  return {
    text,
    signals: {
      wakeNameDetected: detectWakeName(text, wakeName),
      projectHints: findProjectHints(text, projects),
      executorMentions: (["codex", "claude"] as const).filter((name) => containsPhrase(text, name)),
    },
  };
}
