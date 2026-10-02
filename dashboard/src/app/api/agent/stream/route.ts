import type { NextRequest } from "next/server";
import { subscribeToRun, type RunEvent } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

// SSE stream of one agent run: replays past steps, then live events until the
// run finishes. Mirrors the transcript relay stream's shape.
export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId") ?? "";
  if (!runId) return new Response("Missing runId", { status: 400 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: RunEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          // controller closed — cleanup handled below
        }
      };

      const sub = subscribeToRun(runId, send);
      if (!sub) {
        controller.enqueue(
          encoder.encode(
            `event: status\ndata: ${JSON.stringify({
              type: "status",
              status: "error",
              error: "Run not found",
            })}\n\n`
          )
        );
        controller.close();
        return;
      }

      for (const event of sub.replay) send(event);

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {}
      }, HEARTBEAT_MS);

      const close = () => {
        clearInterval(heartbeat);
        sub.unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
