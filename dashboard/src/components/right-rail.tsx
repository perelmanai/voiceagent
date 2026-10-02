"use client";

import {
  ArrowUpRight,
  Bag,
  CalendarBlank,
  Lightning,
  MagnifyingGlass,
  MapPin,
  Info,
  Robot,
} from "@phosphor-icons/react";
import type { Suggestion } from "@/lib/types";
import { AgentPanel } from "./agent-panel";
import { MemoryPanel } from "./memory-panel";

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4">
      {children}
    </div>
  );
}

function kindIcon(kind: Suggestion["kind"]) {
  const props = { size: 14, weight: "duotone" as const };
  switch (kind) {
    case "shop":
      return <Bag {...props} />;
    case "search":
      return <MagnifyingGlass {...props} />;
    case "map":
      return <MapPin {...props} />;
    case "calendar":
      return <CalendarBlank {...props} />;
    case "agent":
      return <Robot {...props} />;
    case "info":
    default:
      return <Info {...props} />;
  }
}

type Props = {
  suggestions: Suggestion[];
  onRunAgent: (task: string) => void;
  requestedTask: { task: string; nonce: number } | null;
  sessionCode: string;
  memoryRefreshKey: number;
  recalledIds: string[];
};

export function RightRail({
  suggestions,
  onRunAgent,
  requestedTask,
  sessionCode,
  memoryRefreshKey,
  recalledIds,
}: Props) {
  return (
    <aside className="flex flex-col gap-5 min-w-0">
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-fg/90">
            <Lightning size={14} weight="duotone" className="text-accent" />
            Suggestions
          </h2>
          <span className="text-[10px] tracking-wider uppercase text-fg-faint font-mono">
            from context
          </span>
        </div>
        <Panel>
          {suggestions.length === 0 ? (
            <div className="text-[12px] text-fg-faint py-2 px-1">
              Nothing yet — Gemini surfaces actionable links and agent tasks
              here as you speak.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {suggestions.map((s) => (
                <li
                  key={s.id}
                  className="slide-in group flex items-start gap-2.5 rounded-xl border border-border bg-white/[0.02] hover:bg-white/[0.04] hover:border-border-strong transition-colors p-2.5"
                >
                  <div className="mt-0.5 size-6 rounded-md bg-accent-soft text-accent grid place-items-center shrink-0">
                    {kindIcon(s.kind)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-fg leading-tight truncate">
                      {s.title}
                    </div>
                    <div className="text-[11px] text-fg-muted leading-snug line-clamp-2 mt-0.5">
                      {s.description}
                    </div>
                  </div>
                  {s.kind === "agent" && s.task ? (
                    <button
                      type="button"
                      onClick={() => onRunAgent(s.task!)}
                      className="shrink-0 flex items-center gap-1 text-[11px] text-accent font-medium rounded-md bg-accent-soft hover:bg-[rgba(247,109,86,0.2)] px-2 py-1 active:scale-[0.97] transition-all"
                    >
                      {s.actionLabel || "Run agent"}
                      <Robot size={11} weight="bold" />
                    </button>
                  ) : (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 flex items-center gap-1 text-[11px] text-accent font-medium rounded-md bg-accent-soft hover:bg-[rgba(247,109,86,0.2)] px-2 py-1 active:scale-[0.97] transition-all"
                    >
                      {s.actionLabel}
                      <ArrowUpRight size={11} weight="bold" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      <AgentPanel requestedTask={requestedTask} sessionCode={sessionCode} />

      <MemoryPanel refreshKey={memoryRefreshKey} recalledIds={recalledIds} />
    </aside>
  );
}
