"use client";

import { useEffect, useRef } from "react";
import type { TranscriptLine } from "@/lib/types";

type Props = {
  lines: TranscriptLine[];
  isRecording: boolean;
};

export function Transcript({ lines, isRecording }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const empty = lines.length === 0;

  return (
    <div
      ref={scrollRef}
      className="scrollbar-thin flex-1 min-h-0 overflow-y-auto pr-2"
    >
      {empty ? (
        <div className="h-full flex flex-col items-start justify-center gap-3 text-fg-faint">
          <div className="font-mono text-xs tracking-wider uppercase">
            Awaiting audio
          </div>
          <div className="text-sm text-fg-muted max-w-sm">
            {isRecording
              ? "Listening — your conversation will appear here in real time."
              : "Toggle the mic to start a session. Browser permission required."}
          </div>
        </div>
      ) : (
        <ol className="space-y-4 py-2" aria-label="Conversation transcript">
          {lines.map((line) => (
            <li
              key={line.id}
              className="grid grid-cols-[88px_1fr] items-baseline gap-x-3"
            >
              <span className="font-mono text-[11px] text-fg-faint tabular-nums pt-0.5">
                [{line.ts}]
              </span>
              <p className="text-[15px] leading-relaxed">
                <span className="text-fg-muted">{line.speaker}:</span>{" "}
                <span className={line.isFinal ? "text-fg" : "text-fg/80"}>
                  {line.text}
                </span>
                {!line.isFinal && (
                  <span className="ml-2 text-[11px] text-fg-faint italic">Listening for the rest…</span>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
