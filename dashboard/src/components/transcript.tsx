"use client";

import { useEffect, useRef } from "react";
import type { TranscriptLine } from "@/lib/types";

type Props = {
  lines: TranscriptLine[];
  interim: string;
  isRecording: boolean;
};

export function Transcript({ lines, interim, isRecording }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines.length, interim]);

  const empty = lines.length === 0 && !interim;

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
              ? "Listening — start speaking and lines will appear here in real time."
              : "Toggle the mic to start a session. Browser permission required."}
          </div>
        </div>
      ) : (
        <ol className="space-y-1.5 py-2">
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
                <span className="text-fg">{line.text}</span>
              </p>
            </li>
          ))}
          {interim && (
            <li className="grid grid-cols-[88px_1fr] items-baseline gap-x-3">
              <span className="font-mono text-[11px] text-fg-faint tabular-nums pt-0.5">
                [ ... ]
              </span>
              <p className="text-[15px] leading-relaxed text-fg-muted italic">
                {interim}
              </p>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
