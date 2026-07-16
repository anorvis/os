import { runAgentProcess } from "../../core/agent/process";

export type ContextConversationInput = {
  text: string;
  compiledContext: unknown;
  now?: Date;
  signal?: AbortSignal;
};

export type ContextConversationRunner = (
  input: ContextConversationInput,
) => Promise<unknown>;

export type ContextConversationDeps = {
  conversation?: ContextConversationRunner;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
};

const MAX_CONTEXT_BYTES = 48_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Run one bounded conversation turn with every tool and extension disabled. */
export async function runContextConversation(
  input: ContextConversationInput,
  deps: ContextConversationDeps = {},
): Promise<string> {
  if (deps.conversation) {
    const result = await deps.conversation(input);
    const text = typeof result === "string"
      ? result
      : isRecord(result) && typeof result.text === "string" ? result.text : "";
    if (!text.trim()) throw new Error("Conversation model returned an empty response");
    return text.trim();
  }

  const context = boundedJson(input.compiledContext, MAX_CONTEXT_BYTES);
  const prompt = [
    "You are the Anorvis Context Conversation agent.",
    "Answer the user's message using only the supplied compiled context.",
    "Do not call tools, access files, browse, make changes, or claim actions you did not perform.",
    "If the context does not contain the answer, say so plainly.",
    "",
    `Compiled context:\n${context}`,
    "",
    `User message:\n${input.text.slice(0, 8_000)}`,
  ].join("\n");
  const command = deps.command ?? process.env.ANORVIS_OMP_COMMAND ?? "omp";
  const result = await runAgentProcess({
    command,
    args: ["--print", "--no-extensions", "--no-skills", "--tools", "", "--name", "Anorvis Context Conversation", prompt],
    cwd: deps.cwd ?? process.cwd(),
    label: "Anorvis Context Conversation",
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: input.signal,
    maxOutputBytes: 128 * 1024,
  });
  if (result.timedOut) throw new Error("Conversation model timed out");
  if (result.cancelled) throw new Error("Conversation model cancelled");
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Conversation model exited with ${result.code}`);
  const text = result.stdout.trim();
  if (!text) throw new Error("Conversation model returned an empty response");
  return text;
}

function boundedJson(value: unknown, maxBytes: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "{}";
  } catch {
    text = "{}";
  }
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n[compiled context truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
