import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getHomeDir } from "../../paths";

export type AgentKind = "wiki" | "tool";
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const MODEL_ENV_BY_AGENT: Record<AgentKind, string> = {
  wiki: "ANORVIS_WIKI_AGENT_MODEL",
  tool: "ANORVIS_TOOL_AGENT_MODEL",
};
const MODEL_FIELD_BY_AGENT: Record<AgentKind, string> = {
  wiki: "wikiModel",
  tool: "toolModel",
};
const THINKING_FIELD_BY_AGENT: Record<AgentKind, string> = {
  wiki: "wikiThinking",
  tool: "toolThinking",
};

export function resolveAgentModel(
  kind: AgentKind,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const environmentModel = env[MODEL_ENV_BY_AGENT[kind]]?.trim();
  return environmentModel || readAgentSetting(MODEL_FIELD_BY_AGENT[kind], env);
}

export function resolveAgentThinking(
  kind: AgentKind,
  env: Record<string, string | undefined> = process.env,
): ThinkingLevel | undefined {
  const value = readAgentSetting(THINKING_FIELD_BY_AGENT[kind], env);
  return THINKING_LEVELS.includes(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}

function readAgentSetting(
  field: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const path =
    env.ANORVIS_AGENT_SETTINGS_PATH ??
    join(getHomeDir(), ".anorvis", "agents.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const setting = (value as Record<string, unknown>)[field];
    return typeof setting === "string" && setting.trim()
      ? setting.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
