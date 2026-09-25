import { APIError, choice, RateLimitError, TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import type { ChoiceQuestion as TypeSafeChoiceQuestion } from "@typesafe-ai/sdk";
import { ProviderError, type JevClassifier, type JevRequest, type JevResponse } from "../types";

const PROVIDER = "typesafe";

export interface TypeSafeJevOptions {
  apiKey: string;
  model: string;
  /** Used by tests to replace the HTTP transport. */
  fetch?: typeof fetch;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof RateLimitError) {
    return new ProviderError(PROVIDER, error.message, {
      rateLimited: true,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  }
  if (error instanceof APIError) {
    return new ProviderError(PROVIDER, error.message, {
      rateLimited: error.status === 429,
      cause: error,
    });
  }
  if (error instanceof TypeSafeError)
    return new ProviderError(PROVIDER, error.message, { cause: error });
  throw error;
}

/** Jev adapter built on the official TypeSafe SDK. */
export function createTypeSafeJev({ apiKey, model, fetch }: TypeSafeJevOptions): JevClassifier {
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: model,
    // withRateLimitRetry owns 429 retries; the classification job retries other failures.
    retry: { maxRetries: 0 },
    // Debug logging writes request bodies, which contain capture text.
    logLevel: "warn",
    ...(fetch ? { fetch } : {}),
  });

  return {
    async classify({ state, questions }: JevRequest): Promise<JevResponse> {
      const sdkQuestions: Record<string, TypeSafeChoiceQuestion> = {};
      for (const [name, question] of Object.entries(questions)) {
        sdkQuestions[name] = choice(question.instructions, question.options);
      }

      const started = performance.now();
      let result;
      try {
        result = await client.systemOne({
          state: JSON.parse(JSON.stringify(state)),
          questions: sdkQuestions,
        });
      } catch (error) {
        throw toProviderError(error);
      }

      const answers: JevResponse["answers"] = {};
      for (const [name, answer] of Object.entries(result.answers)) {
        answers[name] = {
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: { ...answer.probabilities },
        };
      }
      return {
        provider: PROVIDER,
        model: result.model,
        latencyMs: Math.round(performance.now() - started),
        usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
        answers,
      };
    },
  };
}
