import { join } from "node:path";
import { getHomeDir } from "../paths";

export function llmWikiRoot(input: { rootDir?: string } = {}): string {
  return input.rootDir ?? join(getHomeDir(), ".anorvis", "llm-wiki");
}
