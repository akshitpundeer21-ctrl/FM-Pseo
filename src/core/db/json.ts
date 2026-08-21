/**
 * Helpers for the `*Json` string columns.
 *
 * SQLite (and therefore the portable schema) stores structured values as JSON
 * text. Parsing must never throw at read time - a corrupt row should degrade to
 * a default, be logged, and stay visible rather than crash a dashboard page.
 */
import { z } from "zod";

export function readJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Parse + validate in one step; invalid shapes fall back instead of throwing. */
export function readJsonAs<T>(value: string | null | undefined, schema: z.ZodType<T>, fallback: T): T {
  const raw = readJson<unknown>(value, undefined as unknown);
  if (raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

export function writeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function readStringArray(value: string | null | undefined): string[] {
  const parsed = readJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

export function readRecord(value: string | null | undefined): Record<string, unknown> {
  const parsed = readJson<unknown>(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
