"use client";

import { Microphone, MicrophoneSlash, DeviceMobile } from "@phosphor-icons/react";

type Props = {
  isRecording: boolean;
  elapsedSec: number;
  onToggle: () => void;
  pairingCode: string;
  phoneConnected: boolean;
};

function formatElapsed(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function Header({
  isRecording,
  elapsedSec,
  onToggle,
  pairingCode,
  phoneConnected,
}: Props) {
  return (
    <header className="flex items-center justify-between gap-6 px-8 pt-7 pb-5">
      <div className="flex items-center gap-6">
        <h1 className="text-[15px] font-medium tracking-[0.32em] text-fg uppercase">
          Aural Intel
        </h1>

        <div
          className={`flex items-center gap-2 rounded-full px-3 py-1 transition-colors ${
            isRecording
              ? "bg-accent-soft text-accent"
              : "bg-white/[0.04] text-fg-muted"
          }`}
          aria-live="polite"
        >
          <span
            className={`size-1.5 rounded-full ${
              isRecording ? "bg-accent live-dot" : "bg-fg-faint"
            }`}
          />
          <span className="text-[11px] tracking-[0.18em] font-medium uppercase">
            {isRecording ? "Live" : "Idle"}
          </span>
        </div>

        <span className="font-mono text-2xl text-fg/90 tabular-nums">
          {formatElapsed(elapsedSec)}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div
          className={`flex items-center gap-2.5 rounded-full border px-3.5 py-1.5 transition-colors ${
            phoneConnected
              ? "border-[rgba(109,212,154,0.32)] bg-[rgba(109,212,154,0.1)]"
              : "border-border-strong bg-white/[0.04]"
          }`}
          title={
            phoneConnected
              ? "Phone connected — speak into the app"
              : "Open the Android app, enter this code, and start the mic"
          }
        >
          <DeviceMobile
            size={16}
            weight="duotone"
            className={phoneConnected ? "text-confirm" : "text-fg-faint"}
          />
          <span className="text-[10px] tracking-[0.18em] font-medium uppercase text-fg-faint">
            Pair
          </span>
          <span className="font-mono text-sm tracking-[0.28em] text-fg tabular-nums">
            {pairingCode || "····"}
          </span>
        </div>

        <button
          type="button"
          onClick={onToggle}
          className="group flex items-center gap-2.5 rounded-full bg-white/[0.04] border border-border-strong px-4 py-2 text-sm text-fg-muted hover:text-fg hover:bg-white/[0.06] active:scale-[0.98] transition-all"
        >
          <span className="font-medium">
            {isRecording ? "Stop" : "Mic toggle"}
          </span>
          {isRecording ? (
            <MicrophoneSlash size={16} weight="duotone" className="text-accent" />
          ) : (
            <Microphone size={16} weight="duotone" />
          )}
        </button>
      </div>
    </header>
  );
}
