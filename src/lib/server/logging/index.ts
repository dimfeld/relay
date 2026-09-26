export type LogFields = {
  correlationId?: string;
  eventId?: string | null;
  [key: string]: string | number | boolean | null | undefined;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(write: (line: string) => void = console.log) {
  return (level: LogLevel, message: string, values: LogFields = {}) => {
    const { correlationId, ...fields } = values;
    write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        correlationId: correlationId ?? null,
        fields,
      })
    );
  };
}

export const log = createLogger();

export function correlationIdForEvent(event: {
  id: string;
  metadata: Record<string, unknown> | null;
}): string {
  const correlationId = event.metadata?.correlationId;
  return typeof correlationId === "string" && correlationId.length > 0 ? correlationId : event.id;
}
