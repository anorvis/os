import type {
  AuthorizedChannelMessage,
  ChannelIdentity,
  InboundChannelMessage,
} from "./channel";

export type ChannelBinding = {
  identity: ChannelIdentity;
  principalId: string;
  ownerId?: string;
  scopeId?: string;
  channelId?: string;
  workspaceId?: string;
};

export function authorizeChannelMessage(
  message: InboundChannelMessage,
  bindings: readonly ChannelBinding[],
): AuthorizedChannelMessage | undefined {
  const binding = bindings
    .filter((candidate) =>
      candidate.identity.provider === message.identity.provider &&
      (candidate.identity.accountId === "" || candidate.identity.accountId === message.identity.accountId) &&
      candidate.identity.userId === message.identity.userId &&
      (!candidate.scopeId || candidate.scopeId === message.destination.scopeId) &&
      (!candidate.channelId || candidate.channelId === message.destination.channelId) &&
      (!candidate.workspaceId ||
        !message.destination.workspaceId ||
        candidate.workspaceId === message.destination.workspaceId)
    )
    .sort((left, right) => bindingSpecificity(right) - bindingSpecificity(left))[0];
  if (!binding) return undefined;

  const workspaceId = binding.workspaceId ?? message.destination.workspaceId;

  const contextScope = message.destination.visibility === "private" && binding.ownerId
    ? {
        kind: "owner" as const,
        ownerId: binding.ownerId,
        ...(workspaceId ? { workspaceId } : {}),
      }
    : {
        kind: "channel" as const,
        ...(workspaceId ? { workspaceId } : {}),
        channelId: message.destination.channelId,
      };

  return {
    ...message,
    authorization: {
      principalId: binding.principalId,
      contextScope,
    },
  };
}

function bindingSpecificity(binding: ChannelBinding): number {
  return Number(Boolean(binding.scopeId)) +
    Number(Boolean(binding.channelId)) +
    Number(Boolean(binding.workspaceId));
}
