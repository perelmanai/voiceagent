"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Header } from "./header";
import { Waveform } from "./waveform";
import { Transcript } from "./transcript";
import type { Suggestion, TranscriptLine } from "@/lib/types";
import { SpeechConversation, type CompletedTurn, type SpeechInput } from "@/lib/speech-conversation";
import { parseSpeechPayload } from "@/lib/speech-protocol";

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

export function Dashboard() {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Generated client-side only (in an effect) so server and client markup match —
  // a random value in the initial render would cause a hydration mismatch.
  const [pairingCode, setPairingCode] = useState("");
  const [phoneConnected, setPhoneConnected] = useState(false);
  // Memories the co-pilot recalled for the latest suggestion round (highlighted
  // in the Memory panel), and a counter that tells the panel to re-fetch after
  // server-side extraction has had a chance to run.
  const [recalledIds, setRecalledIds] = useState<string[]>([]);
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0);
  // Agent tasks dispatched from suggestion cards flow to the AgentPanel here.
  const [requestedTask, setRequestedTask] = useState<{
    task: string;
    nonce: number;
  } | null>(null);

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

  const pairingCodeRef = useRef(pairingCode);
  pairingCodeRef.current = pairingCode;

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const keepRunningRef = useRef(false);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const mediaRef = useRef<MediaStream | null>(null);
  const conversationRef = useRef<SpeechConversation | null>(null);
  if (!conversationRef.current) conversationRef.current = new SpeechConversation();
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisControllerRef = useRef<AbortController | null>(null);
  const analysisRevisionRef = useRef(0);
  const analysisBacklogRef = useRef<CompletedTurn[]>([]);
  const seenUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!Ctor);
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  const cancelAnalysis = useCallback(() => {
    analysisRevisionRef.current += 1;
    analysisControllerRef.current?.abort();
    analysisControllerRef.current = null;
  }, []);

  const analyzeTurns = useCallback(async (completed: CompletedTurn[]) => {
    if (!completed.length || !mountedRef.current) return;
    cancelAnalysis();
    analysisBacklogRef.current = completed;
    const revision = analysisRevisionRef.current;
    const controller = new AbortController();
    analysisControllerRef.current = controller;
    const recent = conversationRef.current!.snapshot()
      .slice(-6)
      .map((line) => `${line.speaker}: ${line.text}`)
      .join("\n");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          lastFinal: completed.map((turn) => turn.text).join("\n"),
          recent,
          code: pairingCodeRef.current,
        }),
      });
      if (!res.ok) return;
      const data: {
        suggestions?: Array<Partial<Suggestion>>;
        recalled?: Array<{ id: string }>;
      } = await res.json();
      // A pause can resume while the model is answering. Never show suggestions
      // for an older snapshot after speech has changed or the component unmounted.
      if (controller.signal.aborted || revision !== analysisRevisionRef.current || !mountedRef.current) return;
      analysisBacklogRef.current = [];
      setMemoryRefreshKey((k) => k + 1);
      if (Array.isArray(data.recalled)) setRecalledIds(data.recalled.map((r) => r.id));
      if (!Array.isArray(data.suggestions)) return;
      const fresh: Suggestion[] = [];
      for (const s of data.suggestions) {
        if (!s.title) continue;
        const isAgent = s.kind === "agent" && s.task?.trim();
        if (!isAgent && !s.url) continue;
        const dedupeKey = isAgent ? `agent:${s.task}` : s.url!;
        if (seenUrlsRef.current.has(dedupeKey)) continue;
        seenUrlsRef.current.add(dedupeKey);
        fresh.push({
          id: uid(),
          kind: (s.kind as Suggestion["kind"]) ?? "info",
          title: s.title,
          description: s.description ?? "",
          url: s.url ?? "",
          actionLabel: s.actionLabel || (isAgent ? "Run agent" : "Open"),
          createdAt: Date.now(),
          task: s.task,
        });
      }
      if (fresh.length) setSuggestions((prev) => [...fresh, ...prev].slice(0, MAX_SUGGESTIONS));
    } catch {
      // Aborted requests and transient network errors do not interrupt listening.
    } finally {
      if (analysisControllerRef.current === controller) analysisControllerRef.current = null;
    }
  }, [cancelAnalysis]);

  const settleSpeech = useCallback(() => {
    settleTimerRef.current = null;
    if (!mountedRef.current) return;
    const completed = conversationRef.current!.settle(Date.now());
    if (completed.length) {
      setLines(conversationRef.current!.snapshot());
      void analyzeTurns(completed);
    } else if (!conversationRef.current!.isSpeaking()
      && conversationRef.current!.snapshot().every((line) => line.isFinal)
      && !analysisControllerRef.current && analysisBacklogRef.current.length) {
      // A recognizer may never send "end" after noise interrupts a request.
      // The bounded activity timeout also resumes that interrupted analysis.
      void analyzeTurns(analysisBacklogRef.current);
    }
    const deadline = conversationRef.current!.nextDeadline();
    if (deadline !== null) settleTimerRef.current = setTimeout(settleSpeech, Math.max(0, deadline - Date.now()));
  }, [analyzeTurns]);

  const processSpeech = useCallback((input: SpeechInput) => {
    if (!mountedRef.current) return;
    const update = conversationRef.current!.accept(input, Date.now());
    if (!update.changed) return;
    cancelAnalysis();
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    const snapshot = conversationRef.current!.snapshot();
    setLines(snapshot);
    if (update.completed.length) void analyzeTurns(update.completed);
    else if ((input.type === "end" || input.type === "stop") && snapshot.every((line) => line.isFinal)
      && !conversationRef.current!.isSpeaking() && analysisBacklogRef.current.length) {
      // A cough/no-match cycle may interrupt a request without changing any
      // words. Resume that request once the recognizer reports quiet again.
      void analyzeTurns(analysisBacklogRef.current);
    }
    const deadline = conversationRef.current!.nextDeadline();
    if (deadline !== null) settleTimerRef.current = setTimeout(settleSpeech, Math.max(0, deadline - Date.now()));
  }, [analyzeTurns, cancelAnalysis, settleSpeech]);

  // Partial revisions and stable audio chunks from the phone use the same turn
  // buffer as the local mic. Legacy phones can still send just {text}.
  useEffect(() => {
    if (!pairingCode) return;
    const es = new EventSource(`/api/stream?code=${encodeURIComponent(pairingCode)}`);
    es.addEventListener("line", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        const parsed = parseSpeechPayload({ ...data, code: pairingCode });
        if (!parsed) return;
        const line = parsed.line;
        setPhoneConnected(true);
        setError(null);
        processSpeech({
          speaker: "Phone",
          type: line.type ?? "final",
          text: line.text,
          utteranceId: line.utteranceId ?? uid(),
          sequence: line.sequence,
        });
      } catch {
        // Ignore malformed events without disrupting EventSource reconnection.
      }
    });
    return () => es.close();
  }, [pairingCode, processSpeech]);

  const releaseMicrophone = useCallback(() => {
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    mediaRef.current = null;
    setStream(null);
    setIsRecording(false);
  }, []);

  const finishStop = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    try { rec?.abort(); } catch {}
    processSpeech({ speaker: "You", type: "stop", utteranceId: uid() });
  }, [processSpeech]);

  const stop = useCallback(() => {
    keepRunningRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    releaseMicrophone();
    // stop() asks the recognizer for its last final result. Keep its callbacks
    // alive until onend; if it never responds, preserve the visible partial.
    if (recognitionRef.current) {
      stopTimerRef.current = setTimeout(finishStop, 2000);
      try { recognitionRef.current.stop(); } catch { finishStop(); }
    } else {
      finishStop();
    }
  }, [finishStop, releaseMicrophone]);

  const start = useCallback(async () => {
    if (startingRef.current || keepRunningRef.current) return;
    if (recognitionRef.current) finishStop();
    startingRef.current = true;
    setError(null);
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      startingRef.current = false;
      setError("This browser does not expose the Web Speech API. Open the app in Chrome, Edge, Comet, or another Chromium-based browser.");
      return;
    }

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      startingRef.current = false;
      if (mountedRef.current) setError("Microphone permission was denied. Allow mic access in your browser, then toggle again.");
      return;
    }
    startingRef.current = false;
    if (!mountedRef.current) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    mediaRef.current = media;
    setStream(media);
    setElapsedSec(0);

    const rec = new Ctor();
    const sessionId = uid();
    let cycle = 0;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    recognitionRef.current = rec;

    const beginCycle = () => {
      if (!keepRunningRef.current || recognitionRef.current !== rec) return;
      cycle += 1;
      try { rec.start(); } catch {
        keepRunningRef.current = false;
        releaseMicrophone();
        finishStop();
        setError("Speech recognition could not restart. Toggle the mic to try again.");
      }
    };
    rec.onspeechstart = () => {
      if (recognitionRef.current === rec) processSpeech({ speaker: "You", type: "activity", utteranceId: `${sessionId}:${cycle}:activity` });
    };
    rec.onspeechend = () => {
      if (recognitionRef.current === rec) processSpeech({ speaker: "You", type: "pause", utteranceId: `${sessionId}:${cycle}:activity` });
    };
    rec.onresult = (event) => {
      if (recognitionRef.current !== rec) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        processSpeech({
          speaker: "You",
          type: result.isFinal ? "final" : "partial",
          utteranceId: `${sessionId}:${cycle}:${i}`,
          text: result[0].transcript,
        });
      }
    };
    rec.onerror = (event) => {
      if (recognitionRef.current !== rec || event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") {
        setError("Microphone access is blocked or unavailable. Check site permissions and your microphone.");
        keepRunningRef.current = false;
        releaseMicrophone();
        finishStop();
      } else if (event.error === "network") {
        setError("Speech recognition lost network connection. Check your connection.");
      }
    };
    rec.onend = () => {
      if (recognitionRef.current !== rec) return;
      if (!keepRunningRef.current) {
        finishStop();
        return;
      }
      processSpeech({ speaker: "You", type: "end", utteranceId: `${sessionId}:${cycle}:end` });
      restartTimerRef.current = setTimeout(beginCycle, 250);
    };

    keepRunningRef.current = true;
    setIsRecording(true);
    beginCycle();
  }, [finishStop, processSpeech, releaseMicrophone]);

  const toggle = useCallback(() => {
    if (isRecording) stop();
    else void start();
  }, [isRecording, start, stop]);

  const runAgent = useCallback((task: string) => {
    setRequestedTask({ task, nonce: Date.now() });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      keepRunningRef.current = false;
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      analysisControllerRef.current?.abort();
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec?.abort(); } catch {}
      mediaRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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
            {lines.length === 0 ? (
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <PairPanel code={pairingCode} connected={phoneConnected} />
              </div>
            ) : (
              <Transcript
                lines={lines}
                isRecording={isRecording}
              />
            )}
          </div>
        </section>

        <RightRail
          suggestions={suggestions}
          onRunAgent={runAgent}
          requestedTask={requestedTask}
          sessionCode={pairingCode}
          memoryRefreshKey={memoryRefreshKey}
          recalledIds={recalledIds}
        />
      </div>
    </main>
  );
}
