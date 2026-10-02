import type { NextRequest } from "next/server";
import {
  isAgentBusy,
  listRuns,
  startAgentRun,
  stopAgentRun,
} from "@/lib/agent";
import { DEFAULT_AGENT_PROVIDER, parseAgentRequest } from "@/lib/agent-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start an agent run: { task, code?, provider? } → { runId, provider }. */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let input: ReturnType<typeof parseAgentRequest>;
  try {
    input = parseAgentRequest(body);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
  try {
    const { runId } = await startAgentRun(
      input.task,
      input.code,
      input.provider
    );
    return Response.json({ runId, provider: input.provider });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: msg }, { status: isAgentBusy() ? 409 : 500 });
  }
}

/** Recent runs for the panel. */
export async function GET() {
  try {
    return Response.json({
      runs: listRuns(20),
      busy: isAgentBusy(),
      defaultProvider: DEFAULT_AGENT_PROVIDER,
      providers: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }],
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: msg, runs: [] }, { status: 500 });
  }
}

/** Stop a running agent: ?runId=... */
export async function DELETE(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
  return Response.json({ ok: stopAgentRun(runId) });
}
