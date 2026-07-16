import type { ContextSurface, ContextVisibility } from "../../capability/context/schema";

export type ChannelDestination = {
  visibility: ContextVisibility;
  workspaceId?: string;
  scopeId?: string;
  channelId: string;
  threadId?: string;
};

export type ChannelIdentity = {
  provider: ContextSurface;
  accountId: string;
  userId: string;
};

export type InboundChannelMessage = {
  id: string;
  identity: ChannelIdentity;
  destination: ChannelDestination;
  text: string;
  occurredAt: number;
  replyToId?: string;
  attachments: ChannelAttachment[];
};

export type ContextScope =
  | { kind: "owner"; ownerId: string; workspaceId?: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "channel"; workspaceId?: string; channelId: string };

export type AuthorizedChannelMessage = InboundChannelMessage & {
  authorization: {
    principalId: string;
    contextScope: ContextScope;
  };
};

export type ChannelAttachment = {
  id: string;
  name: string;
  mediaType?: string;
  url?: string;
};

export type OutboundChannelMessage = {
  id: string;
  text: string;
  attachments?: ChannelAttachment[];
  replyToId?: string;
};

export type ChannelSendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; retryable: boolean };

export type ChannelReceiver = (message: InboundChannelMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly id: ContextSurface;
  start(receive: ChannelReceiver): Promise<void>;
  stop(): Promise<void>;
  send(
    destination: ChannelDestination,
    message: OutboundChannelMessage,
  ): Promise<ChannelSendResult>;
}
