"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowElbowDownLeft,
  CircleNotch,
  Cursor,
  Eye,
  Globe,
  Lightning,
  Robot,
  StopCircle,
  Warning,
} from "@phosphor-icons/react";
import type { AgentRun, AgentStep } from "@/lib/types";

type Props = {
  /** Set by the dashboard when a suggestion card dispatches a task. */
  requestedTask: { task: string; nonce: number } | null;
  sessionCode: string;
};

function stepIcon(kind: AgentStep["kind"]) {
  const props = { size: 12, weight: "duotone" as const };
  switch (kind) {
    case "thought":
      return <Lightning {...props} />;
    case "tool":
      return <Cursor {...props} />;
    case "observation":
      return <Eye {...props} />;
    case "error":
      return <Warning {...props} />;
    default:
      return <Globe {...props} />;
  }
}

const STATUS_COLOR: Record<string, string> = {
  running: "var(--pending)",
  done: "var(--confirm)",
  error: "var(--high)",
  cancelled: "var(--fg-faint, #6a5f59)",
};

export function AgentPanel({ requestedTask, sessionCode }: Props) {
  const [input, setInput] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState("");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pastRuns, setPastRuns] = useState<AgentRun[]>([]);
  const stepsEndRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/agent");
      if (!res.ok) return;
      const data: { runs?: AgentRun[] } = await res.json();
      if (Array.isArray(data.runs)) {
        setPastRuns(data.runs.filter((r) => r.status !== "running").slice(0, 4));
      }
    } catch {}
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const attachStream = useCallback(
    (runId: string) => {
      esRef.current?.close();
      const es = new EventSource(
        `/api/agent/stream?runId=${encodeURIComponent(runId)}`
      );
      esRef.current = es;
      es.addEventListener("step", (ev: MessageEvent) => {
        try {
          const { step } = JSON.parse(ev.data) as { step: AgentStep };
          setSteps((prev) =>
            prev.some((s) => s.n === step.n) ? prev : [...prev, step]
          );
        } catch {}
      });
      es.addEventListener("status", (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as {
            status: string;
            result?: string;
            error?: string;
          };
          setStatus(data.status);
          if (data.result) setResult(data.result);
          if (data.error) setError(data.error);
          if (data.status !== "running") {
            es.close();
            void loadRuns();
          }
        } catch {}
      });
    },
    [loadRuns]
  );

  const dispatch = useCallback(
    async (task: string) => {
      const clean = task.trim();
      if (!clean) return;
      setError(null);
      setResult(null);
      setSteps([]);
      setActiveTask(clean);
      setStatus("starting");
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: clean, code: sessionCode }),
        });
        const data: { runId?: string; error?: string } = await res.json();
        if (!res.ok || !data.runId) {
          setStatus("error");
          setError(data.error ?? "Failed to start the agent.");
          return;
        }
        setActiveRunId(data.runId);
        setStatus("running");
        attachStream(data.runId);
      } catch {
        setStatus("error");
        setError("Failed to reach the agent API.");
      }
    },
    [attachStream, sessionCode]
  );

  // Tasks dispatched from suggestion cards.
  const lastNonce = useRef(0);
  useEffect(() => {
    if (requestedTask && requestedTask.nonce !== lastNonce.current) {
      lastNonce.current = requestedTask.nonce;
      void dispatch(requestedTask.task);
    }
  }, [requestedTask, dispatch]);

  useEffect(() => () => esRef.current?.close(), []);

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [steps.length]);

  const stop = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await fetch(`/api/agent?runId=${encodeURIComponent(activeRunId)}`, {
        method: "DELETE",
      });
    } catch {}
  }, [activeRunId]);

  const running = status === "running" || status === "starting";

  return (
    <section>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-fg/90">
          <Robot size={14} weight="duotone" className="text-accent" />
          Agent
        </h2>
        <span className="text-[10px] tracking-wider uppercase text-fg-faint font-mono">
          browser + search
        </span>
      </div>
      <div className="rounded-2xl border border-border bg-surface/60 p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) {
              void dispatch(input);
              setInput("");
            }
          }}
          className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-2.5 py-2 focus-within:border-border-strong transition-colors"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={running}
            placeholder={
              running
                ? "Agent is working…"
                : "Tell the agent to do something…"
            }
            className="w-full bg-transparent text-[12px] text-fg placeholder:text-fg-faint outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={running || !input.trim()}
            className="shrink-0 text-fg-faint hover:text-accent disabled:opacity-40 transition-colors"
            title="Run"
          >
            <ArrowElbowDownLeft size={14} weight="bold" />
          </button>
        </form>

        {status !== "idle" && (
          <div className="mt-3 rounded-xl border border-border bg-white/[0.02] p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="size-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: STATUS_COLOR[status] ?? "var(--pending)",
                    }}
                  />
                  <span
                    className="text-[10px] tracking-wider uppercase font-medium"
                    style={{ color: STATUS_COLOR[status] ?? "var(--pending)" }}
                  >
                    {status}
                  </span>
                  {running && (
                    <CircleNotch
                      size={11}
                      className="animate-spin text-fg-faint"
                    />
                  )}
                </div>
                <div className="text-[12px] text-fg mt-1 leading-snug">
                  {activeTask}
                </div>
              </div>
              {running && activeRunId && (
                <button
                  type="button"
                  onClick={stop}
                  title="Stop the agent"
                  className="shrink-0 flex items-center gap-1 text-[11px] text-fg-muted hover:text-accent transition-colors"
                >
                  <StopCircle size={15} weight="duotone" />
                  stop
                </button>
              )}
            </div>

            {steps.length > 0 && (
              <div className="mt-2.5 max-h-[210px] overflow-y-auto scrollbar-thin flex flex-col gap-1 pr-1">
                {steps
                  .filter((s) => s.kind !== "observation")
                  .map((s) => (
                    <div
                      key={s.n}
                      className="slide-in flex items-start gap-2 text-[11px] leading-snug"
                    >
                      <span
                        className={`mt-0.5 shrink-0 ${
                          s.kind === "error" ? "text-high" : "text-fg-faint"
                        }`}
                      >
                        {stepIcon(s.kind)}
                      </span>
                      <span
                        className={
                          s.kind === "final"
                            ? "text-fg"
                            : s.kind === "error"
                              ? "text-high"
                              : "text-fg-muted"
                        }
                      >
                        {s.label}
                        {s.kind === "thought" && s.detail && s.n > 0 && (
                          <span className="text-fg-faint"> — {s.detail.slice(0, 140)}</span>
                        )}
                      </span>
                    </div>
                  ))}
                <div ref={stepsEndRef} />
              </div>
            )}

            {result && (
              <div className="mt-2.5 rounded-lg border border-[rgba(109,212,154,0.25)] bg-[rgba(109,212,154,0.07)] px-3 py-2 text-[12px] text-fg leading-snug whitespace-pre-wrap">
                {result}
              </div>
            )}
            {error && (
              <div className="mt-2.5 rounded-lg border border-[rgba(247,109,86,0.32)] bg-accent-soft px-3 py-2 text-[12px] text-accent leading-snug">
                {error}
              </div>
            )}
          </div>
        )}

        {pastRuns.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {pastRuns.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 text-[11px] text-fg-muted"
              >
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: STATUS_COLOR[r.status] ?? "var(--pending)",
                  }}
                />
                <span className="truncate">{r.task}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
