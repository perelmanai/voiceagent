import type { NextRequest } from "next/server";
import {
  isAgentBusy,
  listRuns,
  startAgentRun,
  stopAgentRun,
} from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start an agent run: { task, code? } → { runId }. */
export async function POST(request: NextRequest) {
  let body: { task?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const task = (body.task ?? "").trim();
  if (!task) {
    return Response.json({ error: "Missing task" }, { status: 400 });
  }
  try {
    const { runId } = await startAgentRun(
      task,
      (body.code ?? "").toUpperCase()
    );
    return Response.json({ runId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: msg }, { status: isAgentBusy() ? 409 : 500 });
  }
}

/** Recent runs for the panel. */
export async function GET() {
  try {
    return Response.json({ runs: listRuns(20), busy: isAgentBusy() });
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
