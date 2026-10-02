import fs from "fs";
import path from "path";

// The browser is driven by Claude Code (the dispatched agent) through the
// Playwright MCP server. This module only builds the stdio server config the
// Agent SDK passes to Claude Code — the SDK spawns and owns the process, one
// per agent run. The browser runs HEADED by default so the user watches the
// agent work, and uses a persistent profile under data/ so logins survive
// across runs.

export type PlaywrightMcpConfig = {
  type: "stdio";
  command: string;
  args: string[];
  /** Per-tool-call timeout (ms) — page loads on slow sites can take a while. */
  timeout: number;
};

// Prefer a browser the user already has (keeps their look/feel and any
// Playwright channel benefits); fall back to Playwright's bundled Chromium.
function detectBrowser(): string {
  if (fs.existsSync("/Applications/Google Chrome.app")) return "chrome";
  if (fs.existsSync("/Applications/Microsoft Edge.app")) return "msedge";
  return "chromium";
}

// Playwright MCP defaults to the "chrome" channel even with no --browser flag,
// so with no Chrome installed we must point it at the bundled Chromium
// (installed via `npx playwright install chromium`) explicitly.
function findBundledChromium(): string | null {
  const cacheDir =
    process.platform === "darwin"
      ? path.join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright")
      : process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
        : path.join(process.env.HOME ?? "", ".cache", "ms-playwright");
  let revisions: string[] = [];
  try {
    revisions = fs
      .readdirSync(cacheDir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  } catch {
    return null;
  }
  for (const rev of revisions) {
    const base = path.join(cacheDir, rev);
    const candidates =
      process.platform === "darwin"
        ? [
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
          ]
        : process.platform === "win32"
          ? ["chrome-win/chrome.exe", "chrome-win64/chrome.exe"]
          : ["chrome-linux/chrome"];
    for (const c of candidates) {
      const p = path.join(base, c);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** Stdio MCP server config for `mcpServers.playwright` in the Agent SDK. */
export function playwrightMcpConfig(): PlaywrightMcpConfig {
  const cliPath = path.join(
    process.cwd(),
    "node_modules",
    "@playwright",
    "mcp",
    "cli.js"
  );
  const args = [
    cliPath,
    "--user-data-dir",
    path.join(process.cwd(), "data", "browser-profile"),
  ];
  const browser = process.env.AGENT_BROWSER || detectBrowser();
  if (browser !== "chromium") {
    args.push("--browser", browser);
  } else {
    // No system Chrome/Edge: use Playwright's bundled Chromium (installed
    // once with `npx playwright install chromium`).
    const exe = findBundledChromium();
    if (exe) args.push("--executable-path", exe);
  }
  if (process.env.AGENT_HEADLESS === "1") args.push("--headless");

  return {
    type: "stdio",
    command: process.execPath,
    args,
    timeout: 90_000,
  };
}
