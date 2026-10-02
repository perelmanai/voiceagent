#!/usr/bin/env node
// The SDK has no ignore-user-config option. Keep the user's login while
// excluding their coding tools, hooks, plugins, and exec policy from this app.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] !== "exec") throw new Error("Only Codex exec is supported");
args.splice(1, 0, "--ignore-user-config", "--ignore-rules", "--ephemeral");
let binary = process.env.AURAL_CODEX_BINARY;
if (!binary) {
  const sdkRequire = createRequire(fileURLToPath(import.meta.resolve("@openai/codex-sdk")));
  const codexRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "linux-x64": "x86_64-unknown-linux-musl",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`Unsupported Codex platform: ${process.platform}-${process.arch}`);
  const packageName = `@openai/codex-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
  const packageRoot = dirname(codexRequire.resolve(`${packageName}/package.json`));
  const vendorRoot = join(packageRoot, "vendor", target);
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  binary = [join(vendorRoot, "bin", name), join(vendorRoot, "codex", name)].find(existsSync);
}
if (!binary || !existsSync(binary)) throw new Error("Codex binary not found. Set CODEX_PATH to your installed codex executable.");

// Replace this process when available: SDK AbortSignal then terminates Codex
// directly. Older Node versions forward termination to the child instead.
if (typeof process.execve === "function") {
  process.execve(binary, [binary, ...args], process.env);
} else {
  const child = spawn(binary, args, { stdio: "inherit", env: process.env });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}
