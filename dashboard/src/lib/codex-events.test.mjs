import test from "node:test";
import assert from "node:assert/strict";
import { createCodexEventState, mapCodexEvent } from "./codex-events.ts";
import { parseAgentRequest } from "./agent-request.ts";

test("actions default to Codex and explicitly preserve Claude selection", () => {
  assert.deepEqual(parseAgentRequest({ task: "  Find coffee  ", code: " abc " }), {
    task: "Find coffee", code: "ABC", provider: "codex",
  });
  assert.equal(parseAgentRequest({ task: "Find coffee", provider: "claude" }).provider, "claude");
});

test("reject malformed action requests before starting any provider", () => {
  for (const body of [null, [], "task", {}, { task: 3 }, { task: " " },
    { task: "hello", provider: "openai" }, { task: "hello", provider: false },
    { task: "hello", provider: null },
    { task: "hello", code: {} }, { task: "x".repeat(20_001) }]) {
    assert.throws(() => parseAgentRequest(body));
  }
});

test("MCP start/update/completion produces one action and its observation", () => {
  const state = createCodexEventState();
  const item = { id: "nav", type: "mcp_tool_call", server: "playwright", tool: "browser_navigate", arguments: { url: "https://example.com" }, status: "in_progress" };
  const started = mapCodexEvent({ type: "item.started", item }, state);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, "tool");
  assert.match(started[0].label, /example.com/);
  assert.deepEqual(mapCodexEvent({ type: "item.updated", item }, state), []);
  const completed = mapCodexEvent({ type: "item.completed", item: { ...item, status: "completed", result: { content: [{ type: "text", text: "Page title: Example Domain" }] } } }, state);
  assert.deepEqual(completed, [{ kind: "observation", label: "→ navigate", detail: "Page title: Example Domain" }]);
});

test("Codex failure after assistant text is not a successful completion", () => {
  const state = createCodexEventState();
  const message = { id: "message", type: "agent_message", text: "Looking up flights" };
  assert.deepEqual(mapCodexEvent({ type: "item.updated", item: message }, state), []);
  mapCodexEvent({ type: "item.completed", item: message }, state);
  assert.equal(state.finalResponse, "Looking up flights");
  assert.equal(state.completed, false);
  assert.throws(() => mapCodexEvent({ type: "turn.failed", error: { message: "Authentication required" } }, state), /Authentication required/);
  assert.equal(state.completed, false);
});

test("completed turn retains final answer and marks success", () => {
  const state = createCodexEventState();
  mapCodexEvent({ type: "item.completed", item: { id: "final", type: "agent_message", text: "Example Domain" } }, state);
  mapCodexEvent({ type: "turn.completed" }, state);
  assert.equal(state.finalResponse, "Example Domain");
  assert.equal(state.completed, true);
});

test("unexpected coding events fail closed", () => {
  for (const type of ["command_execution", "file_change"]) {
    assert.throws(() => mapCodexEvent({ type: "item.started", item: { id: "bad", type } }, createCodexEventState()), /unavailable tool/);
  }
});
