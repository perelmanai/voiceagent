"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Header } from "./header";
import { Waveform } from "./waveform";
import { Transcript } from "./transcript";
import type { Suggestion, TranscriptLine } from "@/lib/types";

const RightRail = dynamic(
  () => import("./right-rail").then((m) => m.RightRail),
  {
    ssr: false,
    loading: () => (
      <aside className="min-h-[320px] rounded-2xl border border-border bg-surface/40 animate-pulse" />
    ),
  }
);

const PairPanel = dynamic(
  () => import("./pair-panel").then((m) => m.PairPanel),
  { ssr: false }
);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function nowTs(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Pairing code shown in the header and entered on the phone. Excludes easily
// confused characters (0/O, 1/I) so it's easy to read off a screen and type.
function genPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

const MAX_SUGGESTIONS = 8;
const ANALYZE_DEBOUNCE_MS = 1200;

export function Dashboard() {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Generated client-side only (in an effect) so server and client markup match —
  // a random value in the initial render would cause a hydration mismatch.
  const [pairingCode, setPairingCode] = useState("");
  const [phoneConnected, setPhoneConnected] = useState(false);

  useEffect(() => {
    const KEY = "aural-pairing-code";
    const stored = localStorage.getItem(KEY);
    if (stored) {
      setPairingCode(stored);
    } else {
      const fresh = genPairingCode();
      localStorage.setItem(KEY, fresh);
      setPairingCode(fresh);
    }
  }, []);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const keepRunningRef = useRef(false);
  const linesRef = useRef<TranscriptLine[]>([]);
  const analyzeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAnalysisRef = useRef<{ lastFinal: string; recent: string } | null>(
    null
  );
  const seenUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const Ctor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!Ctor);
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  const runAnalysis = useCallback(async () => {
    const payload = pendingAnalysisRef.current;
    if (!payload) return;
    pendingAnalysisRef.current = null;
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return;
      const data: { suggestions?: Array<Partial<Suggestion>> } = await res.json();
      if (!Array.isArray(data.suggestions)) return;
      const fresh: Suggestion[] = [];
      for (const s of data.suggestions) {
        if (!s.url || !s.title) continue;
        if (seenUrlsRef.current.has(s.url)) continue;
        seenUrlsRef.current.add(s.url);
        fresh.push({
          id: uid(),
          kind: (s.kind as Suggestion["kind"]) ?? "info",
          title: s.title,
          description: s.description ?? "",
          url: s.url,
          actionLabel: s.actionLabel || "Open",
          createdAt: Date.now(),
        });
      }
      if (fresh.length) {
        setSuggestions((prev) => [...fresh, ...prev].slice(0, MAX_SUGGESTIONS));
      }
    } catch {
      // ignore network/parse errors in the live UI
    }
  }, []);

  const scheduleAnalysis = useCallback(
    (lastFinal: string, recent: string) => {
      pendingAnalysisRef.current = { lastFinal, recent };
      if (analyzeTimerRef.current) clearTimeout(analyzeTimerRef.current);
      analyzeTimerRef.current = setTimeout(runAnalysis, ANALYZE_DEBOUNCE_MS);
    },
    [runAnalysis]
  );

  // Commit a finalized line (from the phone) into the same transcript + analysis
  // pipeline the local mic uses, so suggestions work identically for both sources.
  const commitLine = useCallback(
    (speaker: string, text: string) => {
      const clean = text.trim();
      if (!clean) return;
      const line: TranscriptLine = {
        id: uid(),
        ts: nowTs(),
        speaker,
        text: clean,
        isFinal: true,
      };
      linesRef.current = [...linesRef.current, line];
      setLines(linesRef.current);
      const recent = linesRef.current
        .slice(-6)
        .map((l) => `${l.speaker}: ${l.text}`)
        .join("\n");
      scheduleAnalysis(clean, recent);
    },
    [scheduleAnalysis]
  );

  // Live-listen for transcripts pushed from the paired phone via SSE. The phone is
  // the primary input; the local mic below remains available as a secondary source.
  const commitLineRef = useRef(commitLine);
  commitLineRef.current = commitLine;

  useEffect(() => {
    if (!pairingCode) return;
    const es = new EventSource(
      `/api/stream?code=${encodeURIComponent(pairingCode)}`
    );
    // The dashboard's own SSE stream is always open, so "connected" must mean a phone
    // has actually delivered a line — not merely that this stream opened.
    es.addEventListener("line", (ev: MessageEvent) => {
      try {
        const { text } = JSON.parse(ev.data) as { text: string };
        setPhoneConnected(true);
        setError(null);
        commitLineRef.current("Phone", text);
      } catch {
        // ignore malformed events
      }
    });
    // EventSource reconnects on its own; a transient drop shouldn't flip the phone
    // indicator off, so we don't toggle state here.
    return () => es.close();
  }, [pairingCode]);

  const stop = useCallback(() => {
    keepRunningRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch {}
    recognitionRef.current = null;
    if (analyzeTimerRef.current) {
      clearTimeout(analyzeTimerRef.current);
      analyzeTimerRef.current = null;
    }
    setStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
    setInterim("");
    setIsRecording(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const Ctor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      setError(
        "This browser does not expose the Web Speech API. Open the app in Chrome, Edge, Comet, or another Chromium-based browser."
      );
      return;
    }

    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(
        "Microphone permission was denied. Allow mic access in your browser, then toggle again."
      );
      return;
    }
    setStream(s);
    setElapsedSec(0);

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      let pending = "";
      const linesToCommit: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const text = r[0].transcript.trim();
        if (r.isFinal) {
          if (text) linesToCommit.push(text);
        } else {
          pending += r[0].transcript;
        }
      }
      if (linesToCommit.length) {
        const newLines: TranscriptLine[] = linesToCommit.map((t) => ({
          id: uid(),
          ts: nowTs(),
          speaker: "You",
          text: t,
          isFinal: true,
        }));
        linesRef.current = [...linesRef.current, ...newLines];
        setLines(linesRef.current);
        const recent = linesRef.current
          .slice(-6)
          .map((l) => `${l.speaker}: ${l.text}`)
          .join("\n");
        scheduleAnalysis(linesToCommit[linesToCommit.length - 1], recent);
      }
      setInterim(pending);
    };

    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        setError(
          "Microphone access is blocked. Check site permissions in your browser."
        );
      } else if (event.error === "network") {
        setError(
          "Speech recognition lost network connection. Check your connection."
        );
      }
    };

    rec.onend = () => {
      if (keepRunningRef.current) {
        try {
          rec.start();
        } catch {
          // ignore — will be retried on next end
        }
      }
    };

    keepRunningRef.current = true;
    try {
      rec.start();
    } catch {
      // start() throws if already started — safe to swallow
    }
    recognitionRef.current = rec;
    setIsRecording(true);
  }, [scheduleAnalysis]);

  const toggle = useCallback(() => {
    if (isRecording) stop();
    else void start();
  }, [isRecording, start, stop]);

  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  useEffect(() => () => stopRef.current(), []);

  return (
    <main className="min-h-[100dvh] flex flex-col">
      <Header
        isRecording={isRecording}
        elapsedSec={elapsedSec}
        onToggle={toggle}
        pairingCode={pairingCode}
        phoneConnected={phoneConnected}
      />

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-5 px-8 pb-8 min-h-0">
        <section className="flex flex-col gap-4 min-h-0">
          <div className="rounded-2xl border border-border bg-surface/60 h-[110px] px-5 py-3">
            <Waveform stream={stream} active={isRecording} />
          </div>

          <div className="flex-1 min-h-0 rounded-2xl border border-border bg-surface/40 px-5 py-4 flex flex-col">
            {error && (
              <div className="mb-3 rounded-lg border border-[rgba(247,109,86,0.32)] bg-accent-soft text-accent px-3 py-2 text-[12px]">
                {error}
              </div>
            )}
            {!supported && !error && (
              <div className="mb-3 rounded-lg border border-border bg-white/[0.03] text-fg-muted px-3 py-2 text-[12px]">
                Live transcription requires a Chromium-based browser (Chrome,
                Edge, Comet, Arc).
              </div>
            )}
            {lines.length === 0 && !interim ? (
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <PairPanel code={pairingCode} connected={phoneConnected} />
              </div>
            ) : (
              <Transcript
                lines={lines}
                interim={interim}
                isRecording={isRecording}
              />
            )}
          </div>
        </section>

        <RightRail suggestions={suggestions} />
      </div>
    </main>
  );
}
