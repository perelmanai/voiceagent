import os from "node:os";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reports the URL the phone should use to reach this dashboard over the LAN, so the
// pairing QR is correct even when the page itself was opened on localhost. Picks the
// first non-internal IPv4 address, preferring private ranges.
function isPrivate(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function lanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) candidates.push(ni.address);
    }
  }
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

export function GET(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const port = host.includes(":") ? host.split(":").pop() : "3000";
  const ip = lanIp();
  const url = ip ? `http://${ip}:${port}` : `http://${host}`;
  return Response.json({ url, ip });
}
