import type { ServiceContext, ServiceDefinition } from "../../core/service/service";
import { llmWikiRoutes, type LlmWikiRouteOptions } from "./route";

type LlmWikiServiceContext = ServiceContext & LlmWikiRouteOptions;

export function createLlmWikiService(context: ServiceContext): ServiceDefinition {
  const options = context as LlmWikiServiceContext;
  return { id: "llm-wiki", routes: [llmWikiRoutes({ wikiAgent: options.wikiAgent })] };
}
