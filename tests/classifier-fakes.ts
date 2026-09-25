import type {
  ChoiceAnswer,
  JevClassifier,
  JevRequest,
  LunaExtractor,
  LunaRequest,
} from "../src/lib/server/classifier/types";

export function answer(choice: string, confidence = 0.9): ChoiceAnswer {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

type JevStep = Record<string, string | undefined> | Error;

/** A fake Jev adapter. Each step is a map of question name to selected label, or an error. */
export function fakeJev(...steps: JevStep[]): JevClassifier & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    requests,
    async classify(request) {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return {
        provider: "fake-typesafe",
        model: "jev-test",
        latencyMs: 12,
        usage: { inputTokens: 100, outputTokens: 3 },
        answers: Object.fromEntries(
          Object.entries(step).flatMap(([name, label]) => (label ? [[name, answer(label)]] : []))
        ),
      };
    },
  };
}

/** A fake Luna adapter. Each step is the raw output for one call, or an error. */
export function fakeLuna(...steps: unknown[]): LunaExtractor & { requests: LunaRequest[] } {
  const requests: LunaRequest[] = [];
  return {
    requests,
    async extract(request) {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return {
        provider: "fake-openai",
        model: "luna-test",
        latencyMs: 34,
        usage: { inputTokens: 200, outputTokens: 20 },
        output: step,
      };
    },
  };
}
