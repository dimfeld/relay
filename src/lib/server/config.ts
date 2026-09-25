import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const nonEmpty = z.string().trim().min(1);

const credentials = z.string().transform((value, context) => {
  try {
    const parsed = JSON.parse(value);
    const result = z
      .record(nonEmpty, nonEmpty)
      .refine((entries) => Object.keys(entries).length > 0)
      .safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Report the same error for malformed JSON and invalid credentials.
  }
  context.addIssue({ code: "custom", message: "must be a JSON object of service names to tokens" });
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
