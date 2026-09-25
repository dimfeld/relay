export function serializeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Value cannot be serialized as JSON");
  return json;
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function parseNullableJson<T>(value: string | null): T | null {
  return value === null ? null : parseJson<T>(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}
