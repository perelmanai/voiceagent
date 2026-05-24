"use client";

import { useEffect, useState } from "react";

type Props = {
  code: string;
  connected: boolean;
};

// Shown in the empty transcript area: a QR encoding { url, code } so the phone can
// scan to connect with no typing. The URL comes from /api/host (the Mac's LAN
// address) so the QR is correct even when this page was opened on localhost.
export function PairPanel({ code, connected }: Props) {
  const [qr, setQr] = useState("");
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!code) return;
    let cancelled = false;

    (async () => {
      let base = window.location.origin;
      // Only use the LAN IP from /api/host when the dashboard is on localhost.
      // If opened via a tunnel URL (ngrok, cloudflared, etc.) that URL is already
      // reachable by the phone, so we must use it — not overwrite it with an
      // unreachable LAN address.
      const isLocal =
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1";
      if (isLocal) {
        try {
          const res = await fetch("/api/host");
          if (res.ok) {
            const data: { url?: string } = await res.json();
            if (data.url) base = data.url;
          }
        } catch {
          // fall back to the page origin
        }
      }
      if (cancelled) return;
      setUrl(base);

      const payload = JSON.stringify({ url: base, code });
      try {
        const QRCode = (await import("qrcode")).default;
        const dataUrl = await QRCode.toDataURL(payload, {
          width: 224,
          margin: 1,
          color: { dark: "#14100f", light: "#ffffff" },
        });
        if (!cancelled) setQr(dataUrl);
      } catch {
        // leave qr empty; the code/url text below is still usable
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className="flex flex-col items-center gap-5 text-center max-w-sm">
      <div className="font-mono text-xs tracking-wider uppercase text-fg-faint">
        {connected ? "Phone connected — start speaking" : "Scan to connect your phone"}
      </div>

      <div className="rounded-2xl bg-white p-3 shadow-lg shadow-black/30">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="Pairing QR code" width={224} height={224} />
        ) : (
          <div className="size-[224px] grid place-items-center text-[#14100f] text-sm">
            Generating…
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-1">
        <div className="text-sm text-fg-muted">
          Open <span className="font-medium text-fg">Aural Voice</span> on your phone
          (same Wi-Fi) and tap <span className="font-medium text-fg">Scan QR</span>.
        </div>
        <div className="text-[12px] text-fg-faint">
          or enter manually:{" "}
          <span className="font-mono text-fg-muted">{url || "…"}</span>
          {" · code "}
          <span className="font-mono tracking-[0.2em] text-fg-muted">{code || "…"}</span>
        </div>
      </div>
    </div>
  );
}
