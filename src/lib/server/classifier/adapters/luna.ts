import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError } from "ai";
import { ProviderError, type LunaExtractor, type LunaRequest, type LunaResponse } from "../types";

const PROVIDER = "openai";

export interface OpenAILunaOptions {
  apiKey: string;
  model: string;
  /** Used by tests to replace the HTTP transport. */
  fetch?: typeof fetch;
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const milliseconds = Number(headers?.["retry-after-ms"]);
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  const seconds = Number(headers?.["retry-after"]);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  return undefined;
}

function toProviderError(error: unknown): ProviderError {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause)) {
    return new ProviderError(PROVIDER, cause.message, {
      rateLimited: cause.statusCode === 429,
      retryAfterMs: retryAfterMs(cause.responseHeaders),
      cause,
    });
  }
  if (error instanceof Error) return new ProviderError(PROVIDER, error.message, { cause: error });
  throw error;
}

function parseText(text: string | undefined): unknown {
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Luna adapter built on the Vercel AI SDK with schema checked output. */
export function createOpenAILuna({ apiKey, model, fetch }: OpenAILunaOptions): LunaExtractor {
  const openai = createOpenAI({ apiKey, ...(fetch ? { fetch } : {}) });

  return {
    async extract({
      actionType,
      schema,
      instructions,
      prompt,
    }: LunaRequest): Promise<LunaResponse> {
      const started = performance.now();
      const metadata = () => ({
        provider: PROVIDER,
        model,
        latencyMs: Math.round(performance.now() - started),
      });
      try {
        const result = await generateText({
          model: openai(model),
          instructions,
          prompt,
          output: Output.object({ schema, name: actionType.replace(".", "_") }),
          // withRateLimitRetry owns 429 retries; the classification job retries other failures.
          maxRetries: 0,
        });
        return {
          ...metadata(),
          model: result.response.modelId || model,
          usage: {
            inputTokens: result.usage.inputTokens ?? null,
            outputTokens: result.usage.outputTokens ?? null,
          },
          output: result.output,
        };
      } catch (error) {
        // Schema failures return the raw output so the service can validate it and request a repair.
        if (NoObjectGeneratedError.isInstance(error)) {
          return {
            ...metadata(),
            usage: error.usage
              ? {
                  inputTokens: error.usage.inputTokens ?? null,
                  outputTokens: error.usage.outputTokens ?? null,
                }
              : null,
            output: parseText(error.text),
          };
        }
        throw toProviderError(error);
      }
    },
  };
}
