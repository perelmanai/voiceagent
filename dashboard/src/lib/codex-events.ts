import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentStep } from "./types";

export type CodexStep = Pick<AgentStep, "kind" | "label" | "detail">;
type EventState = { finalResponse: string; completed: boolean; toolIds: Set<string> };
export function createCodexEventState(): EventState {
  return { finalResponse: "", completed: false, toolIds: new Set() };
}

/** Only completed text is emitted, so repeated item updates don't duplicate it. */
export function mapCodexEvent(event: ThreadEvent, state: EventState): CodexStep[] {
  if (event.type === "error") throw new Error(event.message);
  if (event.type === "turn.failed") throw new Error(event.error.message);
  if (event.type === "turn.completed") {
    state.completed = true;
    return [];
  }
  if (event.type === "thread.started") {
    return [{ kind: "thought", label: "Codex session started", detail: "Preparing browser, web search, and memory tools." }];
  }
  if (!("item" in event)) return [];
  const item = event.item;
  const done = event.type === "item.completed";
  switch (item.type) {
    case "agent_message":
      if (!done || !item.text.trim()) return [];
      state.finalResponse = item.text.trim();
      return [{ kind: "thought", label: "Codex", detail: item.text }];
    case "reasoning":
      return done && item.text.trim() ? [{ kind: "thought", label: "Thinking", detail: item.text }] : [];
    case "mcp_tool_call": {
      const steps: CodexStep[] = [];
      const name = item.tool.replace(/^browser_/, "").replace(/_/g, " ");
      if (!state.toolIds.has(item.id)) {
        state.toolIds.add(item.id);
        const args = item.arguments as Record<string, unknown> | null;
        const hint = args?.url ?? args?.query ?? args?.text ?? args?.element ?? "";
        steps.push({ kind: "tool", label: hint ? `${name}: ${String(hint).slice(0, 80)}` : name, detail: JSON.stringify(item.arguments) ?? "" });
      }
      if (done) {
        const detail = item.error?.message || item.result?.content
          .filter((block) => block.type === "text")
          .map((block) => block.type === "text" ? block.text : "").join("\n") || "(no output)";
        steps.push({ kind: item.status === "failed" ? "error" : "observation", label: `→ ${name}`, detail });
      }
      return steps;
    }
    case "web_search":
      if (state.toolIds.has(item.id)) return [];
      state.toolIds.add(item.id);
      return [{ kind: "tool", label: `Web search: ${item.query}`, detail: item.query }];
    case "todo_list":
      return done ? [{ kind: "thought", label: "Plan", detail: item.items.map((todo) => `${todo.completed ? "✓" : "○"} ${todo.text}`).join("\n") }] : [];
    case "error":
      return done ? [{ kind: "error", label: "Codex notice", detail: item.message }] : [];
    case "command_execution":
    case "file_change":
      throw new Error("Codex attempted an unavailable tool. This action runner only supports browser, web search, and memory tools.");
  }
}
