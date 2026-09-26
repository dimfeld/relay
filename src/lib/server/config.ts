import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const nonEmpty = z.string().trim().min(1);

export const DEFAULT_CONTEXT_LIMIT = 10;
export const DEFAULT_CONTEXT_MAX_AGE_MINUTES = 15;
/**
 * With the queue backoff (5 s doubling to a 15 min cap), ten attempts cover an owner outage of
 * about 36 minutes before a delivery becomes dead and needs a manual retry.
 */
export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 10;

export const SERVICE_CAPABILITIES = [
  "events:publish",
  "coding:request",
  "deploy:request",
  "admin:read",
] as const;

export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];

const serviceCredential = z.object({
  token: nonEmpty,
  capabilities: z.array(z.enum(SERVICE_CAPABILITIES)),
});

const credentials = z.string().transform((value, context) => {
  try {
    const parsed = JSON.parse(value);
    const result = z
      .record(nonEmpty, serviceCredential)
      .refine((entries) => Object.keys(entries).length > 0)
      .safeParse(parsed);
    if (result.success) {
      const tokens = Object.values(result.data).map((credential) => credential.token);
      if (new Set(tokens).size === tokens.length) return result.data;
      context.addIssue({ code: "custom", message: "each service must have a distinct token" });
      return z.NEVER;
    }
  } catch {
    // Report the same error for malformed JSON and invalid credentials.
  }
  context.addIssue({
    code: "custom",
    message: `must be a JSON object of service names to { token, capabilities }, with capabilities from: ${SERVICE_CAPABILITIES.join(", ")}`,
  });
  return z.NEVER;
});

const schema = z
  .object({
    PUBLIC_PORT: port,
    INTERNAL_PORT: port,
    DATABASE_PATH: nonEmpty,
    PEBBLE_WEBHOOK_SECRETS: z.string().transform((value, context) => {
      const secrets = value.split(",").map((secret) => secret.trim());
      if (secrets.length && secrets.every(Boolean)) return secrets;
      context.addIssue({
        code: "custom",
        message: "must contain one or more comma-separated secrets",
      });
      return z.NEVER;
    }),
    PEBBLE_MAX_BODY_BYTES: z.coerce.number().int().positive().default(65_536),
    PEBBLE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
    INTERNAL_SERVICE_CREDENTIALS: credentials,
    INTERNAL_API_MAX_BODY_BYTES: z.coerce.number().int().positive().default(65_536),
    DELIVERY_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_DELIVERY_MAX_ATTEMPTS),
    WAKE_NAME: nonEmpty.optional(),
    DEFAULT_EXECUTOR: z.enum(["codex", "claude"]),
    CODEX_EXECUTABLE: nonEmpty,
    CLAUDE_EXECUTABLE: nonEmpty,
  })
  .refine((value) => value.PUBLIC_PORT !== value.INTERNAL_PORT, {
    path: ["INTERNAL_PORT"],
    message: "must differ from PUBLIC_PORT",
  });

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(
  environment: Record<string, string | undefined> = process.env
): AppConfig {
  return parseEnvironment(schema, environment);
}

function parseEnvironment<T extends z.ZodType>(
  schema: T,
  environment: Record<string, string | undefined>
): z.infer<T> {
  const result = schema.safeParse(environment);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join(".") || "configuration";
    return `${name}: ${issue.message}`;
  });
  throw new Error(`Invalid environment configuration:\n${problems.join("\n")}`);
}

const classifierSchema = z.object({
  TYPESAFE_API_KEY: nonEmpty,
  OPENAI_API_KEY: nonEmpty,
  JEV_MODEL: nonEmpty.default("jev-latest"),
  LUNA_MODEL: nonEmpty.default("gpt-6-luna"),
  CLASSIFIER_CONTEXT_LIMIT: z.coerce.number().int().positive().default(DEFAULT_CONTEXT_LIMIT),
  CLASSIFIER_CONTEXT_MAX_AGE_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CONTEXT_MAX_AGE_MINUTES),
  /** IANA time zone used to resolve relative reminder times such as "tomorrow morning". */
  TIME_ZONE: nonEmpty.optional(),
});

export type ClassifierConfig = z.infer<typeof classifierSchema>;

/** Load the provider settings. Only the process that runs the classification worker needs them. */
export function loadClassifierConfig(
  environment: Record<string, string | undefined> = process.env
): ClassifierConfig {
  return parseEnvironment(classifierSchema, environment);
}
