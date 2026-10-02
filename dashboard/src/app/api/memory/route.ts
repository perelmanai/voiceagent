import type { NextRequest } from "next/server";
import {
  deleteMemory,
  listMemories,
  memoryStats,
  saveMemory,
} from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List memories. Query params: q (search), type, limit. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const type = request.nextUrl.searchParams.get("type") ?? undefined;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  try {
    return Response.json({
      memories: listMemories({ q, type, limit }),
      stats: memoryStats(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: msg, memories: [] }, { status: 500 });
  }
}

/** Manually add a memory: { content, type?, category? }. */
export async function POST(request: NextRequest) {
  let body: {
    content?: string;
    type?: string;
    category?: string;
    code?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.content?.trim()) {
    return Response.json({ error: "Missing content" }, { status: 400 });
  }
  const memory = await saveMemory(
    { content: body.content, type: body.type, category: body.category },
    (body.code ?? "").toUpperCase()
  );
  return Response.json({ memory });
}

/** Delete a memory: ?id=... */
export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  return Response.json({ ok: deleteMemory(id) });
}
