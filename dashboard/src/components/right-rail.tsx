"use client";

import {
  ArrowUpRight,
  Bag,
  CalendarBlank,
  MagnifyingGlass,
  MapPin,
  Info,
} from "@phosphor-icons/react";
import type { Suggestion } from "@/lib/types";

const PEOPLE = [
  {
    initial: "E",
    name: "Elena Marsh",
    role: "Project Lead",
    topic: "Quarterly Review",
    conf: "97%",
    tone: "rose",
  },
  {
    initial: "M",
    name: "Marcus Tovani",
    role: "Logistics Analyst",
    topic: "Supply Chain",
    conf: "91%",
    tone: "teal",
  },
  {
    initial: "P",
    name: "Priya Joshi",
    role: "Financial Officer",
    topic: "Q3 Planning",
    conf: "93%",
    tone: "amber",
  },
] as const;

const EVENTS = [
  {
    status: "Confirmed",
    statusColor: "var(--confirm)",
    title: "Q3 Strategy Meeting",
    when: "Tomorrow, 10:00 AM – 11:00 AM",
    who: "E. Marsh, M. Tovani, P. Joshi",
  },
  {
    status: "Tentative",
    statusColor: "var(--pending)",
    title: "Logistics Sync",
    when: "Thu, 2:00 PM – 3:00 PM",
    who: "M. Tovani, Logistics Team",
  },
];

const TASKS = [
  {
    title: "Resolve Supply Chain Bottleneck",
    agent: "M. Tovani",
    priority: "var(--high)",
  },
  {
    title: "Update Q3 Financial Projections",
    agent: "P. Joshi",
    priority: "var(--pending)",
  },
  {
    title: "Draft Meeting Minutes",
    agent: "E. Marsh",
    priority: "var(--confirm)",
  },
];

const TONE_BG: Record<string, string> = {
  rose: "bg-[#e8826b]",
  teal: "bg-[#7ec5b8]",
  amber: "bg-[#e8b657]",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[13px] font-medium text-fg/90 px-1 mb-3">
      {children}
    </h2>
  );
}

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
    case "info":
    default:
      return <Info {...props} />;
  }
}

export function RightRail({ suggestions }: { suggestions: Suggestion[] }) {
  return (
    <aside className="flex flex-col gap-5 min-w-0">
      <section>
        <SectionLabel>People</SectionLabel>
        <Panel>
          <div className="grid grid-cols-3 gap-3">
            {PEOPLE.map((p) => (
              <div key={p.name} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-1">
                  <div
                    className={`size-8 rounded-full grid place-items-center text-[13px] font-medium text-bg ${TONE_BG[p.tone]}`}
                  >
                    {p.initial}
                  </div>
                  <span className="text-[10px] font-mono text-fg-muted bg-white/[0.04] border border-border rounded-md px-1.5 py-0.5 tabular-nums">
                    {p.conf} Conf.
                  </span>
                </div>
                <div className="leading-tight">
                  <div className="text-sm font-medium text-fg truncate">
                    {p.name}
                  </div>
                  <div className="text-[11px] text-fg-muted truncate">
                    {p.role}
                  </div>
                </div>
                <div className="text-[10px] text-fg-muted bg-white/[0.03] border border-border rounded-md px-2 py-1 truncate">
                  {p.topic}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section>
        <SectionLabel>Events</SectionLabel>
        <Panel>
          <div className="grid grid-cols-2 gap-3">
            {EVENTS.map((e) => (
              <div key={e.title} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: e.statusColor }}
                  />
                  <span
                    className="text-[10px] tracking-wider uppercase font-medium"
                    style={{ color: e.statusColor }}
                  >
                    {e.status}
                  </span>
                </div>
                <div className="text-sm font-medium text-fg leading-tight">
                  {e.title}
                </div>
                <div className="text-[11px] text-fg-muted leading-snug">
                  {e.when}
                </div>
                <div className="text-[11px] text-fg-faint leading-snug truncate">
                  {e.who}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-[13px] font-medium text-fg/90">Suggestions</h2>
          <span className="text-[10px] tracking-wider uppercase text-fg-faint font-mono">
            from context
          </span>
        </div>
        <Panel>
          {suggestions.length === 0 ? (
            <div className="text-[12px] text-fg-faint py-2 px-1">
              Nothing yet — Gemini surfaces actionable links here as you speak.
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
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 flex items-center gap-1 text-[11px] text-accent font-medium rounded-md bg-accent-soft hover:bg-[rgba(247,109,86,0.2)] px-2 py-1 active:scale-[0.97] transition-all"
                    >
                      {s.actionLabel}
                      <ArrowUpRight size={11} weight="bold" />
                    </a>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      </section>

      <section>
        <SectionLabel>Tasks</SectionLabel>
        <Panel>
          <ul className="flex flex-col gap-2">
            {TASKS.map((t) => (
              <li
                key={t.title}
                className="flex items-center gap-3 rounded-xl bg-white/[0.02] border border-border p-2.5 pr-2"
              >
                <span
                  className="self-stretch w-[3px] rounded-full"
                  style={{ backgroundColor: t.priority }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-fg leading-tight truncate">
                    {t.title}
                  </div>
                  <div className="text-[11px] text-fg-muted mt-0.5">
                    <span className="font-mono uppercase tracking-wider text-fg-faint">
                      Agent
                    </span>{" "}
                    {t.agent}
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 flex items-center gap-1 text-[11px] text-accent font-medium rounded-md bg-accent-soft hover:bg-[rgba(247,109,86,0.2)] px-2 py-1 active:scale-[0.97] transition-all"
                >
                  dispatch
                  <ArrowUpRight size={11} weight="bold" />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </section>
    </aside>
  );
}
