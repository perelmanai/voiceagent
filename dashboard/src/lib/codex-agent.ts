import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { playwrightMcpConfig } from "./mcp";
import { startCodexMemoryServer } from "./codex-memory";
import { createCodexEventState, mapCodexEvent, type CodexStep } from "./codex-events";

export async function executeCodexRun(options: {
  prompt: string;
  systemPrompt: string;
  sessionCode: string;
  signal: AbortSignal;
  onStep: (step: CodexStep) => void;
}): Promise<string> {
  options.signal.throwIfAborted();
  const workspace = await mkdtemp(path.join(tmpdir(), "aural-codex-"));
  let memory: Awaited<ReturnType<typeof startCodexMemoryServer>> | undefined;
  try {
    memory = await startCodexMemoryServer(options.sessionCode);
    options.signal.throwIfAborted();
    const browser = playwrightMcpConfig();
    // Only transport/auth environment reaches the subprocess. App database and
    // unrelated API keys are not inherited by browser tools.
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "USERPROFILE", "CODEX_HOME", "TMPDIR", "TEMP", "SYSTEMROOT", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    const localBinary = path.join(homedir(), ".local", "bin", "codex");
    if (process.env.CODEX_PATH) env.AURAL_CODEX_BINARY = process.env.CODEX_PATH;
    else if (existsSync(localBinary)) env.AURAL_CODEX_BINARY = localBinary;
    env.AURAL_MEMORY_TOKEN = memory.token;
    const config: CodexOptions["config"] = {
      developer_instructions: options.systemPrompt,
      project_doc_max_bytes: 0,
      skills: { include_instructions: false, bundled: { enabled: false } },
      features: {
        shell_tool: false, unified_exec: false, view_image: false,
        apps: false, plugins: false, hooks: false, multi_agent: false,
        // MCP execution uses the tool host even when Code Mode is disabled.
        code_mode: false, code_mode_host: true,
        browser_use: false, computer_use: false, image_generation: false,
        skill_search: false, workspace_dependencies: false,
      },
      mcp_servers: {
        playwright: {
          command: browser.command,
          args: browser.args,
          startup_timeout_sec: 60,
          tool_timeout_sec: browser.timeout / 1000,
          required: true,
          // The task dispatch authorizes browser actions; this noninteractive
          // runner cannot answer MCP approval prompts. Coding tools stay off.
          default_tools_approval_mode: "approve",
          // Exclude arbitrary JavaScript and local file upload from this runner.
          disabled_tools: ["browser_run_code", "browser_evaluate", "browser_file_upload"],
        },
        memory: {
          url: memory.url,
          bearer_token_env_var: "AURAL_MEMORY_TOKEN",
          required: true,
          default_tools_approval_mode: "approve",
        },
      },
    };
    const codex = new Codex({
      codexPathOverride: path.join(process.cwd(), "scripts", "codex-agent.mjs"),
      apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined,
      env,
      config,
    });
    const thread = codex.startThread({
      model: process.env.CODEX_AGENT_MODEL || undefined,
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchMode: "live",
    });
    const state = createCodexEventState();
    const { events } = await thread.runStreamed(options.prompt, { signal: options.signal });
    for await (const event of events) {
      options.signal.throwIfAborted();
      for (const step of mapCodexEvent(event, state)) options.onStep(step);
    }
    options.signal.throwIfAborted();
    if (!state.completed) throw new Error("Codex ended without completing the task.");
    if (!state.finalResponse) throw new Error("Codex finished without a summary.");
    return state.finalResponse;
  } finally {
    await memory?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}
