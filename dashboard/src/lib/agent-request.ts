import type { AgentProvider } from "./types";

export const DEFAULT_AGENT_PROVIDER: AgentProvider = "codex";

/** Validate untrusted JSON before reserving the browser or creating a run. */
export function parseAgentRequest(body: unknown): {
  task: string;
  code: string;
  provider: AgentProvider;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected a JSON object");
  }
  const input = body as Record<string, unknown>;
  if (typeof input.task !== "string" || !input.task.trim()) {
    throw new Error("Missing task");
  }
  if (input.task.length > 20_000) throw new Error("Task is too long");
  if (input.code !== undefined && typeof input.code !== "string") {
    throw new Error("Invalid session code");
  }
  const provider = input.provider === undefined ? DEFAULT_AGENT_PROVIDER : input.provider;
  if (provider !== "codex" && provider !== "claude") {
    throw new Error("Provider must be codex or claude");
  }
  return {
    task: input.task.trim(),
    code: ((input.code as string | undefined) ?? "").trim().toUpperCase(),
    provider,
  };
}
