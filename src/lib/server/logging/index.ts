export type LogFields = {
  correlationId?: string;
  eventId?: string;
  [key: string]: string | number | boolean | null | undefined;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(write: (line: string) => void = console.log) {
  return (level: LogLevel, message: string, fields: LogFields = {}) => {
    write(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields }));
  };
}

export const log = createLogger();
