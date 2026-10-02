"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  MagnifyingGlass,
  Sparkle,
  Trash,
} from "@phosphor-icons/react";
import type { MemoryItem, MemoryType } from "@/lib/types";

const TYPE_COLORS: Record<MemoryType, string> = {
  preference: "#e8826b",
  fact: "#7ec5b8",
  person: "#e8b657",
  place: "#9db8e8",
  plan: "#c79de8",
  interest: "#a8d67e",
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type Props = {
  /** Bumped by the dashboard after each analyze so freshly extracted memories appear. */
  refreshKey: number;
  /** Memories the co-pilot just recalled to inform suggestions — briefly highlighted. */
  recalledIds: string[];
};

export function MemoryPanel({ refreshKey, recalledIds }: Props) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(async () => {
    try {
      const q = queryRef.current.trim();
      const res = await fetch(
        `/api/memory?limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`
      );
      if (!res.ok) return;
      const data: { memories?: MemoryItem[]; stats?: { total: number } } =
        await res.json();
      if (Array.isArray(data.memories)) setMemories(data.memories);
      if (data.stats) setTotal(data.stats.total);
    } catch {
      // transient — next refresh catches up
    }
  }, []);

  // Extraction runs server-side after each analyze; give it a moment to land.
  useEffect(() => {
    const t = setTimeout(load, 3500);
    return () => clearTimeout(t);
  }, [refreshKey, load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(load, 350);
    return () => clearTimeout(t);
  }, [query, load]);

  const remove = useCallback(
    async (id: string) => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      try {
        await fetch(`/api/memory?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      } finally {
        void load();
      }
    },
    [load]
  );

  const recalledSet = new Set(recalledIds);
  const shown = expanded ? memories : memories.slice(0, 6);

  return (
    <section>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-fg/90">
          <Brain size={14} weight="duotone" className="text-accent" />
          Memory
        </h2>
        <span className="text-[10px] tracking-wider uppercase text-fg-faint font-mono tabular-nums">
          {total} stored
        </span>
      </div>
      <div className="rounded-2xl border border-border bg-surface/60 p-4">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-2.5 py-1.5 mb-3 focus-within:border-border-strong transition-colors">
          <MagnifyingGlass size={13} className="text-fg-faint shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search what the agent knows…"
            className="w-full bg-transparent text-[12px] text-fg placeholder:text-fg-faint outline-none"
          />
        </div>

        {shown.length === 0 ? (
          <div className="text-[12px] text-fg-faint py-2 px-1">
            {query
              ? "No memories match."
              : "Nothing remembered yet — speak, and durable facts (places, foods, plans, preferences) are saved here automatically."}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((m) => {
              const recalled = recalledSet.has(m.id);
              return (
                <li
                  key={m.id}
                  className={`group flex items-start gap-2.5 rounded-xl border p-2.5 transition-colors ${
                    recalled
                      ? "border-[rgba(247,109,86,0.35)] bg-accent-soft"
                      : "border-border bg-white/[0.02] hover:bg-white/[0.04]"
                  }`}
                >
                  <span
                    className="mt-1 size-2 rounded-full shrink-0"
                    style={{ backgroundColor: TYPE_COLORS[m.type] }}
                    title={m.type}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] text-fg leading-snug">
                      {m.content}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-fg-faint font-mono">
                      <span className="uppercase tracking-wider">
                        {m.type}
                        {m.category ? ` · ${m.category}` : ""}
                      </span>
                      <span>{timeAgo(m.updatedAt)}</span>
                      {m.reinforcements > 1 && (
                        <span
                          className="flex items-center gap-0.5"
                          title="Times this fact resurfaced"
                        >
                          <Sparkle size={9} weight="fill" />
                          {m.reinforcements}
                        </span>
                      )}
                      {recalled && (
                        <span className="text-accent uppercase tracking-wider">
                          recalled
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(m.id)}
                    title="Forget this"
                    className="opacity-0 group-hover:opacity-100 shrink-0 text-fg-faint hover:text-accent transition-all p-1"
                  >
                    <Trash size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {memories.length > 6 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 w-full text-center text-[11px] text-fg-faint hover:text-fg-muted transition-colors py-1"
          >
            {expanded ? "Show less" : `Show all ${memories.length}`}
          </button>
        )}
      </div>
    </section>
  );
}
