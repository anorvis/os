/**
 * Background SnapTrade sync loop. SnapTrade data is otherwise snapshot-on-demand:
 * the only sync triggers are the web UI button and portal close, so dashboards
 * go stale silently. This loop refreshes the local snapshot on an interval and
 * emits the same finance.changed invalidation as the manual sync route, which
 * the web app already consumes over SSE to refetch open views.
 *
 * Read-only like everything else in the SnapTrade integration; a tick is a
 * no-op unless credentials are saved and the provider is connected.
 */
import { emitInvalidation } from "../../core/events/events";
import { getSnapTradeSettings, syncSnapTrade } from "./snaptrade";

export type SnapTradeAutoSyncTickResult =
  | "synced"
  | "skipped-disconnected"
  | "skipped-inflight"
  | "failed";

export type SnapTradeAutoSyncDeps = {
  settings?: () => { connected: boolean };
  sync?: () => Promise<{ warnings: string[] }>;
  invalidate?: () => void;
  log?: (message: string) => void;
};

export type SnapTradeAutoSync = {
  tick: () => Promise<SnapTradeAutoSyncTickResult>;
  start: () => void;
  stop: () => void;
};

const DEFAULT_INTERVAL_MS = 3_600_000;
const MIN_INTERVAL_MS = 300_000;
const FIRST_TICK_DELAY_MS = 30_000;

export function snapTradeAutoSyncIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ANORVIS_SNAPTRADE_SYNC_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MS;
  if (value <= 0) return 0;
  return Math.max(value, MIN_INTERVAL_MS);
}

export function createSnapTradeAutoSync(
  deps: SnapTradeAutoSyncDeps = {},
  intervalMs = snapTradeAutoSyncIntervalMs(),
): SnapTradeAutoSync {
  const settings = deps.settings ?? getSnapTradeSettings;
  const sync = deps.sync ?? syncSnapTrade;
  const invalidate =
    deps.invalidate ??
    (() =>
      emitInvalidation({
        type: "finance.changed",
        entityId: "snaptrade",
        domain: "finance",
      }));
  const log = deps.log ?? ((message: string) => console.log(message));

  let inFlight = false;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<SnapTradeAutoSyncTickResult> => {
    if (!settings().connected) return "skipped-disconnected";
    if (inFlight) return "skipped-inflight";
    inFlight = true;
    try {
      const summary = await sync();
      invalidate();
      const warnings = summary.warnings.length
        ? ` · warnings: ${summary.warnings.join(" · ")}`
        : "";
      log(`snaptrade auto-sync ok${warnings}`);
      return "synced";
    } catch (error) {
      log(
        `snaptrade auto-sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "failed";
    } finally {
      inFlight = false;
    }
  };

  const stop = () => {
    clearTimeout(firstTimer);
    clearInterval(intervalTimer);
    firstTimer = undefined;
    intervalTimer = undefined;
  };

  const start = () => {
    if (intervalMs === 0) return;
    stop();
    firstTimer = setTimeout(() => {
      void tick();
    }, FIRST_TICK_DELAY_MS);
    firstTimer.unref?.();
    intervalTimer = setInterval(() => {
      void tick();
    }, intervalMs);
    intervalTimer.unref?.();
  };

  return { tick, start, stop };
}
