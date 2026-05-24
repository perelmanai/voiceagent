import type { NextRequest } from "next/server";
import { publish } from "@/lib/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Android app posts here. It is not a browser so CORS does not gate it, but we
// keep permissive headers + an OPTIONS handler so the endpoint also works from any
// future browser-based sender or a quick fetch test.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: NextRequest) {
  let body: { code?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400, headers: CORS }
    );
  }

  const code = (body.code ?? "").trim().toUpperCase();
  const text = (body.text ?? "").trim();

  if (!code || !text) {
    return Response.json(
      { ok: false, error: "Missing code or text" },
      { status: 400, headers: CORS }
    );
  }

  publish(code, { text, ts: Date.now() });
  return Response.json({ ok: true }, { headers: CORS });
}
