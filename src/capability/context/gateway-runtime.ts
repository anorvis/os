import type { ContextMonitorRuntime } from "./runtime";
import type { ContextOutboundRuntime, DiscordContextRuntime } from "./runtime";

export type ContextGatewayRuntimeParts = {
  monitor?: ContextMonitorRuntime;
  outbound?: ContextOutboundRuntime;
  discord?: DiscordContextRuntime;
};

/** Own every context runtime so the gateway has one start/stop boundary. */
export class ContextGatewayRuntime {
  private readonly parts: ContextGatewayRuntimeParts;
  private started = false;
  constructor(parts: ContextGatewayRuntimeParts) {
    this.parts = parts;
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.parts.discord) await this.parts.discord.start();
    await Promise.all([
      this.parts.monitor?.start() ?? Promise.resolve(),
      this.parts.outbound?.start() ?? Promise.resolve(),
    ]);
  }
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await Promise.all([
      this.parts.discord?.stop() ?? Promise.resolve(),
      this.parts.monitor?.stop() ?? Promise.resolve(),
      this.parts.outbound?.stop() ?? Promise.resolve(),
    ]);
  }
}
