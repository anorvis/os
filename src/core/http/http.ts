import { Schema } from "effect";
import { decodeUnknownResult } from "../effect/schema";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const JsonTextSchema = Schema.parseJson(Schema.Unknown);

export type JsonParseResult = {
  ok: true;
  value: JsonValue;
} | {
  ok: false;
  error: string;
};


export function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, accept",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

export async function parseJsonRequest(request: Request): Promise<JsonParseResult> {
  const text = await request.text();
  if (!text.trim()) return { ok: false, error: "JSON body is required" };
  const decoded = decodeUnknownResult(JsonTextSchema, text);
  if (!decoded.ok) return { ok: false, error: "invalid JSON body" };
  return isJsonValue(decoded.value) ? { ok: true, value: decoded.value } : { ok: false, error: "invalid JSON body" };
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validDateParam(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}
