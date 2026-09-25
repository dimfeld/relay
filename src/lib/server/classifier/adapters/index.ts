import type { ClassifierConfig } from "../../config";
import type { JevClassifier, LunaExtractor } from "../types";
import { createTypeSafeJev } from "./jev";
import { createOpenAILuna } from "./luna";

export function createProviderAdapters(config: ClassifierConfig): {
  jev: JevClassifier;
  luna: LunaExtractor;
} {
  return {
    jev: createTypeSafeJev({ apiKey: config.TYPESAFE_API_KEY, model: config.JEV_MODEL }),
    luna: createOpenAILuna({ apiKey: config.OPENAI_API_KEY, model: config.LUNA_MODEL }),
  };
}
