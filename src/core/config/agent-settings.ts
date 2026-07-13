import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getHomeDir } from "../../paths";

export type AgentKind = "wiki" | "tool";

type AgentSettings = {
  wikiModel?: string;
  toolModel?: string;
};

const MODEL_ENV_BY_AGENT: Record<AgentKind, string> = {
  wiki: "ANORVIS_WIKI_AGENT_MODEL",
  tool: "ANORVIS_TOOL_AGENT_MODEL",
};

const MODEL_FIELD_BY_AGENT: Record<AgentKind, keyof AgentSettings> = {
  wiki: "wikiModel",
  tool: "toolModel",
};

export function resolveAgentModel(
  kind: AgentKind,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const environmentModel = env[MODEL_ENV_BY_AGENT[kind]]?.trim();
  if (environmentModel) return environmentModel;
  const path =
    env.ANORVIS_AGENT_SETTINGS_PATH ??
    join(getHomeDir(), ".anorvis", "agents.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const field = (value as Record<string, unknown>)[MODEL_FIELD_BY_AGENT[kind]];
    return typeof field === "string" && field.trim()
      ? field.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
