import type { z } from "zod";
import type { ExtractableActionType, executorProvider } from "./schemas";

export type ExecutorProvider = z.infer<typeof executorProvider>;

export interface RegisteredProject {
  id: string;
  name: string;
  aliases: string[];
}

/** A recent capture selected for classification, with its downstream note ID when known. */
export interface ContextItem {
  eventId: string;
  text: string;
  actionType: string | null;
  noteId: string | null;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Metadata recorded for every provider call. Never includes credentials or hidden reasoning. */
export interface CallMetadata {
  provider: string;
  model: string;
  latencyMs: number;
  usage: Usage | null;
}

/** A provider failure. Adapters convert SDK errors to this type so callers can retry on 429. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly rateLimited: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    provider: string,
    message: string,
    options: { rateLimited?: boolean; retryAfterMs?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.rateLimited = options.rateLimited ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ChoiceQuestion {
  instructions: string;
  /** Option labels mapped to their descriptions. */
  options: Record<string, string>;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
}

export interface JevRequest {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface JevResponse extends CallMetadata {
  answers: Record<string, ChoiceAnswer>;
}

/** Jev answers choice questions. It never produces dates, titles, note text, paths, or commands. */
export interface JevClassifier {
  classify(request: JevRequest): Promise<JevResponse>;
}

export interface LunaRequest {
  actionType: ExtractableActionType;
  schema: z.ZodType;
  instructions: string;
  prompt: string;
}

export interface LunaResponse extends CallMetadata {
  /** The parsed model output, or the raw text when it was not valid JSON. Callers must validate it. */
  output: unknown;
}

/** Luna extracts the fields for one fixed action type. It never selects the action type. */
export interface LunaExtractor {
  extract(request: LunaRequest): Promise<LunaResponse>;
}
