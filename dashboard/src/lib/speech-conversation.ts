import type { TranscriptLine } from "./types";

export type SpeechInput = {
  speaker: string;
  type: "activity" | "partial" | "final" | "stop" | "end" | "pause";
  utteranceId: string;
  text?: string;
  sequence?: number;
};

type Segment = { id: string; text: string; final: boolean; sequence: number };
type Turn = {
  id: string;
  speaker: string;
  startedAt: number;
  updatedAt: number;
  segments: Segment[];
  settled: boolean;
};

export type CompletedTurn = { id: string; speaker: string; text: string };

export const SENTENCE_QUIET_MS = 1800;
export const UNPUNCTUATED_QUIET_MS = 3500;
export const MAX_SPEECH_QUIET_MS = 5000;

// Recognition's "final" means a stable audio chunk, not a finished thought.
// These conservative English cues also work when ASR adds an early full stop.
// Without a semantic model this is a heuristic: ambiguous unpunctuated speech
// gets a longer quiet window; dangling clauses use the bounded fallback below.
export function sentenceQuietWindow(text: string): number | null {
  const clean = text.trim();
  if (!clean) return null;
  const words = clean.toLowerCase().replace(/[.!?…,:;"'“”‘’()[\]]+$/g, "").trim();
  const completeQuestion = /^(what|who|which|where)\b/i.test(clean) && /\?$/.test(clean)
    && /\b(for|to|with|at|about|from|of|in|on)$/.test(words);
  const completeRelativeClause = /\b(what|who|which)\b.*\b(looking|looked|asking|asked|waiting|waited|hoping|hoped|searching|searched) (for|at)$/.test(words)
    || /\b(where|who|what) (i|you|he|she|it|we|they) (am|is|are|was|were)$/.test(words);
  const completeReply = /^(yes|no|sure|of course)[,\s]+(i|you|he|she|it|we|they) (can|will|would|could|should|am|is|are|was|were)$/.test(words);
  if (
    (!completeQuestion && !completeRelativeClause && !completeReply && /\b(and|or|but|because|although|unless|if|while|whereas|whether|to|of|for|with|from|at|in|on|into|about|than|a|an|the|my|your|our|their|is|are|was|were|be|been|being|will|would|could|should|can|must|might|shall)$/.test(words)) ||
    /\b(and then|so that|in order|as soon as|such as|i want|i need|i am going|i'm going|let me|can you|could you|would you|we should|i think that)$/.test(words) ||
    /[,;:\-–—…]$/.test(clean)
  ) return null;
  return /[.!?]["'”’)]*$/.test(clean)
    ? SENTENCE_QUIET_MS
    : UNPUNCTUATED_QUIET_MS;
}

function joinSegments(segments: Segment[]): string {
  let text = "";
  for (const segment of segments) {
    if (!segment.text) continue;
    // Some recognizers insert a full stop at every silence, including after
    // "a flight to." Remove only that clearly unfinished boundary on resume.
    if (text && sentenceQuietWindow(text) === null) text = text.replace(/[.!?]+(["'”’)]*)$/, "$1");
    text = text ? `${text} ${segment.text}` : segment.text;
  }
  return text;
}

/** Pure clock-driven buffer shared by phone and browser recognition events. */
export class SpeechConversation {
  private turns: Turn[] = [];
  private segments = new Map<string, { turn: Turn; segment: Segment }>();
  private speaking = new Map<string, { key: string; updatedAt: number }>();
  private activitySequence = new Map<string, number>();
  private nextId = 0;

  isSpeaking(): boolean {
    return this.speaking.size > 0;
  }

  snapshot(): TranscriptLine[] {
    return this.turns.map((turn) => ({
      id: turn.id,
      ts: new Date(turn.startedAt).toLocaleTimeString("en-GB", { hour12: false }),
      speaker: turn.speaker,
      text: joinSegments(turn.segments),
      isFinal: turn.settled,
    }));
  }

  accept(input: SpeechInput, now: number): { changed: boolean; completed: CompletedTurn[] } {
    const key = `${input.speaker}:${input.utteranceId}`;
    const previous = this.segments.get(key);
    const sequence = input.sequence ?? (previous ? previous.segment.sequence + 1 : 0);
    if (input.sequence !== undefined) {
      const last = this.activitySequence.get(key);
      if (last !== undefined && sequence <= last) return { changed: false, completed: [] };
      this.activitySequence.set(key, sequence);
    }

    if (input.type === "pause") {
      if (this.speaking.get(input.speaker)?.key !== key) return { changed: false, completed: [] };
      this.speaking.delete(input.speaker);
      for (const turn of this.turns) {
        if (turn.speaker === input.speaker && !turn.settled) turn.updatedAt = now;
      }
      return { changed: true, completed: [] };
    }

    if (input.type === "stop" || input.type === "end") {
      let changed = this.speaking.has(input.speaker);
      this.speaking.delete(input.speaker);
      const completed: CompletedTurn[] = [];
      for (const turn of this.turns) {
        if (turn.speaker !== input.speaker || turn.settled) continue;
        for (const segment of turn.segments) {
          if (!segment.final) {
            segment.final = true;
            changed = true;
          }
        }
        // An unexpected recognition end is just a pause. Only the user's Stop
        // explicitly flushes an unfinished sentence or the last partial result.
        if (input.type === "stop") {
          completed.push(this.complete(turn));
          changed = true;
        }
      }
      return { changed, completed };
    }

    if (input.type === "activity") {
      if (previous?.segment.final) return { changed: false, completed: [] };
      this.speaking.set(input.speaker, { key, updatedAt: now });
      for (const turn of this.turns) {
        if (turn.speaker === input.speaker && !turn.settled) turn.updatedAt = now;
      }
      return { changed: true, completed: [] };
    }

    const text = (input.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) return { changed: false, completed: [] };
    const final = input.type === "final";
    // A fallback may have already analyzed this exact preview. A late final
    // confirms it without reopening the turn or issuing duplicate suggestions.
    if (final && previous?.turn.settled && previous.segment.text === text) {
      previous.segment.final = true;
      previous.segment.sequence = sequence;
      if (this.speaking.get(input.speaker)?.key === key) this.speaking.delete(input.speaker);
      return { changed: false, completed: [] };
    }
    // Replayed finals and late partials must neither duplicate words nor reopen
    // a sentence. A changed final may still correct its own stable segment ID.
    if (previous && (
      (previous.segment.final && !final) ||
      (previous.segment.text === text && previous.segment.final === final)
    )) return { changed: false, completed: [] };

    // Android's activity and final share an utterance ID. Browser audio activity
    // has its own ID and ends via onspeechend: an older result must not clear it.
    const activity = this.speaking.get(input.speaker);
    if (final && activity?.key === key) this.speaking.delete(input.speaker);
    else if (activity) activity.updatedAt = now;
    if (previous) {
      previous.segment.text = text;
      previous.segment.final = final;
      previous.segment.sequence = sequence;
      previous.turn.updatedAt = now;
      previous.turn.settled = false;
    } else {
      const latest = this.turns.at(-1);
      const turn = latest && latest.speaker === input.speaker && !latest.settled
        ? latest
        : {
            id: `turn-${++this.nextId}`,
            speaker: input.speaker,
            startedAt: now,
            updatedAt: now,
            segments: [],
            settled: false,
          };
      if (turn !== latest) this.turns.push(turn);
      const segment = { id: key, text, final, sequence };
      turn.segments.push(segment);
      turn.updatedAt = now;
      this.segments.set(key, { turn, segment });
    }
    return { changed: true, completed: [] };
  }

  nextDeadline(): number | null {
    let deadline: number | null = null;
    // Missing end/final callbacks must not leave the source marked as speaking
    // forever, including when a noise-only cycle interrupted an analysis.
    for (const activity of this.speaking.values()) {
      deadline = Math.min(deadline ?? Infinity, activity.updatedAt + MAX_SPEECH_QUIET_MS);
    }
    for (const turn of this.turns) {
      if (turn.settled) continue;
      deadline = Math.min(deadline ?? Infinity, this.turnDeadline(turn));
    }
    return deadline;
  }

  settle(now: number): CompletedTurn[] {
    const completed: CompletedTurn[] = [];
    for (const [speaker, activity] of this.speaking) {
      if (now >= activity.updatedAt + MAX_SPEECH_QUIET_MS) this.speaking.delete(speaker);
    }
    for (const turn of this.turns) {
      if (!turn.settled && now >= this.turnDeadline(turn)) completed.push(this.complete(turn));
    }
    return completed;
  }

  private turnDeadline(turn: Turn): number {
    const fallback = turn.updatedAt + MAX_SPEECH_QUIET_MS;
    if (this.speaking.has(turn.speaker) || turn.segments.some((segment) => !segment.final)) return fallback;
    const delay = sentenceQuietWindow(joinSegments(turn.segments)) ?? MAX_SPEECH_QUIET_MS;
    return Math.min(fallback, turn.updatedAt + delay);
  }

  private complete(turn: Turn): CompletedTurn {
    turn.settled = true;
    return { id: turn.id, speaker: turn.speaker, text: joinSegments(turn.segments) };
  }
}
