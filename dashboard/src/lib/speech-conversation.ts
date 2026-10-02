import type { TranscriptLine } from "./types";

export type SpeechInput = {
  speaker: string;
  type: "activity" | "partial" | "final" | "stop" | "end" | "pause";
  utteranceId: string;
  text?: string;
  sequence?: number;
};

type Segment = { id: string; text: string; final: boolean; sequence: number };
type Recognition = {
  turn: Turn;
  segment: Segment;
  sourceText: string;
  frozenPrefix: string;
};
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

// Cumulative ASR revisions can keep the same result ID after a timeout. Compare
// words rather than punctuation/case so an inserted period cannot replay an old
// sentence. A rewrite of already completed words is not a new conversation turn.
function suffixAfterPrefix(prefix: string, text: string): string | null {
  const words = (value: string) => [...value.matchAll(/[^\s.,!?;:"()[\]{}…“”]+/g)]
    .map((match) => ({
      key: match[0].toLowerCase().replace(/’/g, "'").replace(/^'+|'+$/g, ""),
      start: match.index!,
    })).filter((word) => word.key);
  const frozen = words(prefix);
  const incoming = words(text);
  if (incoming.length < frozen.length || frozen.some((word, index) => word.key !== incoming[index]?.key)) {
    // A correction to an old word must not swallow a clearly new request:
    // "I need flour." -> "I need flowers. Now find a florist." Keep the old
    // turn immutable, but retain an additional explicit topic transition.
    const priorTopics = [...prefix.matchAll(new RegExp(`\\b${NEW_THOUGHT_PATTERN}`, "gi"))];
    const incomingTopics = [...text.matchAll(new RegExp(`\\b${NEW_THOUGHT_PATTERN}`, "gi"))];
    const nextTopic = incomingTopics[priorTopics.length];
    return nextTopic ? text.slice(nextTopic.index!).trim() : null;
  }
  if (incoming.length === frozen.length) return "";
  return text.slice(incoming[frozen.length].start).trim();
}

const NEW_THOUGHT_PATTERN = "(?:(?:now|next|also)[,:]?\\s+(?:i|we|can|could|please|find|show|book|look|search|let['’]s)\\b|moving on\\b|on another (?:topic|note)\\b|another (?:question|thing)\\b)";

function startsNewThought(text: string): boolean {
  return new RegExp(`^${NEW_THOUGHT_PATTERN}`, "i").test(text);
}

function hasCompleteChunks(segments: Segment[]): boolean {
  return segments.length > 0 && segments.every((segment) => segment.final)
    && sentenceQuietWindow(joinSegments(segments)) !== null;
}

/** Pure clock-driven buffer shared by phone and browser recognition events. */
export class SpeechConversation {
  private turns: Turn[] = [];
  private segments = new Map<string, Recognition>();
  private latestRecognition = new Map<string, string>();
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
    // Timers may be delayed in a background tab. A new utterance must not extend
    // an expired turn just because its timer callback has not run yet.
    const speakingBefore = this.speaking.size;
    const completed = this.settle(now);
    const settledChanged = completed.length > 0 || speakingBefore !== this.speaking.size;
    const result = (changed: boolean) => ({ changed: changed || settledChanged, completed });
    const key = `${input.speaker}:${input.utteranceId}`;
    const previous = this.segments.get(key);
    const sequence = input.sequence ?? (previous ? previous.segment.sequence + 1 : 0);
    if (input.sequence !== undefined) {
      const last = this.activitySequence.get(key);
      if (last !== undefined && sequence <= last) return result(false);
      this.activitySequence.set(key, sequence);
    }

    if (input.type === "pause") {
      if (this.speaking.get(input.speaker)?.key !== key) return result(false);
      this.speaking.delete(input.speaker);
      for (const turn of this.turns) {
        if (turn.speaker === input.speaker && !turn.settled) turn.updatedAt = now;
      }
      return result(true);
    }

    if (input.type === "stop" || input.type === "end") {
      let changed = this.speaking.has(input.speaker);
      this.speaking.delete(input.speaker);
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
      return result(changed);
    }

    if (input.type === "activity") {
      if (previous?.segment.final) return result(false);
      this.speaking.set(input.speaker, { key, updatedAt: now });
      for (const turn of this.turns) {
        if (turn.speaker === input.speaker && !turn.settled) turn.updatedAt = now;
      }
      return result(true);
    }

    const sourceText = (input.text ?? "").replace(/\s+/g, " ").trim();
    if (!sourceText) return result(false);
    const final = input.type === "final";
    let text = sourceText;
    if (previous?.frozenPrefix) {
      // Once a newer result ID starts, older cumulative revisions are stale.
      // They must not append a new tail to either the old or the current turn.
      if (previous.turn.settled && this.latestRecognition.get(input.speaker) !== key) return result(false);
      const suffix = suffixAfterPrefix(previous.frozenPrefix, sourceText);
      if (suffix === null || !suffix) {
        if (final && suffix === "" && this.speaking.get(input.speaker)?.key === key) {
          this.speaking.delete(input.speaker);
          return result(true);
        }
        return result(false);
      }
      text = suffix;
    }

    // Revisions replace only an open segment. Completed text is immutable; any
    // genuine cumulative suffix starts in a new turn below.
    const active = previous && !previous.turn.settled ? previous : undefined;
    if (active && (
      (active.segment.final && !final) ||
      (active.segment.text === text && active.segment.final === final)
    )) return result(false);

    // A new topic can be explicit before the silence timer elapses. If its
    // first partial was only "Now", move that still-open segment out once the
    // recognizer expands it to "Now I need..."; completed text stays separate.
    if (active && startsNewThought(text) && active.turn === this.turns.at(-1)
      && active.turn.segments.at(-1) === active.segment
      && hasCompleteChunks(active.turn.segments.slice(0, -1))) {
      active.turn.segments.pop();
      completed.push(this.complete(active.turn));
      const next: Turn = {
        id: `turn-${++this.nextId}`, speaker: input.speaker,
        startedAt: now, updatedAt: now, segments: [active.segment], settled: false,
      };
      active.turn = next;
      this.turns.push(next);
    }

    // Android's activity and final share an utterance ID. Browser audio activity
    // has its own ID and ends via onspeechend: an older result must not clear it.
    const activity = this.speaking.get(input.speaker);
    if (final && activity?.key === key) this.speaking.delete(input.speaker);
    else if (activity) activity.updatedAt = now;
    if (active) {
      active.segment.text = text;
      active.segment.final = final;
      active.segment.sequence = sequence;
      active.sourceText = sourceText;
      active.turn.updatedAt = now;
    } else {
      const latest = this.turns.at(-1);
      if (latest && latest.speaker === input.speaker && !latest.settled
        && hasCompleteChunks(latest.segments) && startsNewThought(text)) {
        completed.push(this.complete(latest));
      }
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
      this.segments.set(key, {
        turn, segment, sourceText,
        frozenPrefix: previous?.frozenPrefix ?? "",
      });
      this.latestRecognition.set(input.speaker, key);
    }
    return result(true);
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
    for (const segment of turn.segments) {
      const recognition = this.segments.get(segment.id);
      if (recognition?.turn === turn && recognition.segment === segment) {
        recognition.frozenPrefix = recognition.sourceText;
      }
    }
    return { id: turn.id, speaker: turn.speaker, text: joinSegments(turn.segments) };
  }
}
