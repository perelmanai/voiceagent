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
  // Recognition callbacks and sentence analysis boundaries are not speaker
  // changes. Keep consecutive speech together in readable conversation blocks.
  const groups: TranscriptLine[][] = [];
  for (const line of lines) {
    const previous = groups.at(-1);
    if (previous && previous[0].speaker === line.speaker && previous.reduce((size, item) => size + item.text.length, 0) < 900) {
      previous.push(line);
    } else {
      groups.push([line]);
    }
  }

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
          {groups.map((group) => (
            <li
              key={group[0].id}
              className="grid grid-cols-[88px_1fr] items-baseline gap-x-3"
            >
              <span className="font-mono text-[11px] text-fg-faint tabular-nums pt-0.5">
                [{group[0].ts}]
              </span>
              <p className="text-[15px] leading-relaxed">
                <span className="text-fg-muted">{group[0].speaker}:</span>{" "}
                {group.map((line, index) => (
                  <span key={line.id} className={line.isFinal ? "text-fg" : "text-fg/80"}>
                    {index > 0 ? " " : ""}{line.text}
                  </span>
                ))}
                {group.some((line) => !line.isFinal) && (
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
