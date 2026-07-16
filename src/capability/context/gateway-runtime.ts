import type { ContextMonitorRuntime } from "./runtime";
import type { ContextOutboundRuntime, DiscordContextRuntime } from "./runtime";

type MonitorPart = Pick<ContextMonitorRuntime, "start" | "stop">;
type OutboundPart = Pick<ContextOutboundRuntime, "start" | "stop" | "drain">;
type DiscordPart = Pick<DiscordContextRuntime, "start" | "stop"> & {
  /**
   * Stop accepting new inbound messages without closing the provider adapter.
   * Older runtimes may omit these hooks; the fallback keeps their lifecycle
   * usable, while current runtimes keep the adapter alive for outbound drain.
   */
  stopInbound?: () => Promise<void>;
  stopAdapter?: () => Promise<void>;
};

export type ContextGatewayRuntimeParts = {
  monitor?: MonitorPart;
  outbound?: OutboundPart;
  discord?: DiscordPart;
};

type ResourceState = {
  monitor: boolean;
  outbound: boolean;
  discord: boolean;
  adapter: boolean;
  inbound: boolean;
};

/** Own every context runtime so the gateway has one start/stop boundary. */
export class ContextGatewayRuntime {
  private readonly parts: ContextGatewayRuntimeParts;
  private resources: ResourceState = {
    monitor: false,
    outbound: false,
    discord: false,
    adapter: false,
    inbound: false,
  };
  private started = false;
  private transition: Promise<void> | undefined;

  constructor(parts: ContextGatewayRuntimeParts) {
    this.parts = parts;
  }

  async start(): Promise<void> {
    while (this.transition) await this.transition;
    if (this.started) return;

    const transition = this.startInternal();
    this.transition = transition;
    try {
      await transition;
    } finally {
      if (this.transition === transition) this.transition = undefined;
    }
  }

  async stop(): Promise<void> {
    while (this.transition) {
      const transition = this.transition;
      await transition.catch(() => undefined);
      if (this.transition === transition) break;
    }
    if (!this.started && !this.hasResources()) return;

    const transition = this.stopInternal();
    this.transition = transition;
    try {
      await transition;
    } finally {
      if (this.transition === transition) this.transition = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const discord = this.parts.discord;
    try {
      if (discord) {
        this.resources.discord = true;
        this.resources.adapter = true;
        this.resources.inbound = true;
        await discord.start();
      }

      const starts: Promise<void>[] = [];
      const monitor = this.parts.monitor;
      const outbound = this.parts.outbound;
      if (monitor) this.resources.monitor = true;
      if (outbound) this.resources.outbound = true;
      if (monitor) starts.push(Promise.resolve().then(() => monitor.start()));
      if (outbound) starts.push(Promise.resolve().then(() => outbound.start()));
      const results = await Promise.allSettled(starts);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
      this.started = true;
    } catch (error) {
      this.started = false;
      const cleanupErrors = await this.stopResources();
      if (!cleanupErrors.length) throw error;
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Context gateway startup and cleanup failed",
      );
    }
  }

  private async stopInternal(): Promise<void> {
    this.started = false;
    const errors = await this.stopResources();
    throwErrors(errors, "Context gateway shutdown failed");
  }

  private async stopResources(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const monitor = this.parts.monitor;
    if (monitor && this.resources.monitor) {
      try {
        await monitor.stop();
        this.resources.monitor = false;
      } catch (error) {
        errors.push(error);
      }
    }

    const discord = this.parts.discord;
    if (discord && this.resources.inbound) {
      try {
        if (discord.stopInbound) {
          await discord.stopInbound();
        } else {
          await discord.stop();
          this.resources.adapter = false;
        }
        this.resources.inbound = false;
      } catch (error) {
        errors.push(error);
      }
    }

    const outbound = this.parts.outbound;
    if (outbound && this.resources.outbound) {
      try {
        // Drain before stop: stop() marks the runtime stopped and would make
        // a later drain a no-op. Failed rows remain leased/retryable.
        await outbound.drain();
      } catch (error) {
        errors.push(error);
      }
      try {
        await outbound.stop();
        this.resources.outbound = false;
      } catch (error) {
        errors.push(error);
      }
    }

    if (discord && this.resources.adapter) {
      try {
        if (discord.stopAdapter) {
          await discord.stopAdapter();
        } else {
          await discord.stop();
        }
        this.resources.adapter = false;
        this.resources.discord = false;
      } catch (error) {
        errors.push(error);
      }
    } else if (!this.resources.adapter) {
      this.resources.discord = false;
    }

    return errors;
  }

  private hasResources(): boolean {
    return Object.values(this.resources).some(Boolean);
  }
}

function throwErrors(errors: readonly unknown[], message: string): void {
  if (!errors.length) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
