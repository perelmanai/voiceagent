import type { NextRequest } from "next/server";
import { subscribe, type RelayLine } from "@/lib/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

// SSE endpoint the dashboard subscribes to. Streams transcript lines published by the
// Android app for the matching pairing code.
export async function GET(request: NextRequest) {
  const code = (request.nextUrl.searchParams.get("code") ?? "")
    .trim()
    .toUpperCase();

  if (!code) {
    return new Response("Missing code", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      // Open the stream immediately so the client's onopen fires.
      send("ready", { code });

      const unsubscribe = subscribe(code, (line: RelayLine) => {
        try {
          send("line", line);
        } catch {
          // controller closed mid-send; cleanup below handles it
        }
      });

      // Keep proxies/tunnels from closing an idle connection.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // ignore — abort handler will clean up
        }
      }, HEARTBEAT_MS);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
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
