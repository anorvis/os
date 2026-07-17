import { ConvexError } from "convex/values";

// Providers signal throttling with HTTP 429, usually alongside a Retry-After
// header or a "try again in N seconds" hint in the body. Convert that into a
// ConvexError carrying retryAfterMs so the sync runner can reschedule the job
// for when the provider is ready instead of burning retries into a failure.
export function throwIfRateLimited(
  response: Response,
  provider: string,
  body?: string,
): void {
  if (response.status !== 429) return;
  throw new ConvexError({
    code: "RATE_LIMITED",
    message: `${provider} throttled the request${body ? `: ${body.slice(0, 200)}` : ""}`,
    retryAfterMs: retryAfterMs(response, body),
  });
}

function retryAfterMs(response: Response, body?: string): number {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header) * 1_000;
  const detail = body ? /in (\d+(?:\.\d+)?) seconds/i.exec(body) : null;
  const seconds = detail ? Number(detail[1]) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds) * 1_000
    : 60_000;
}
