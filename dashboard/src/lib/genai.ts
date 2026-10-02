import { GoogleGenAI } from "@google/genai";

// Model aliases resolve server-side on Google's end, so retired point versions
// (e.g. gemini-2.5-flash, which this key can no longer call) don't break us.
export const MODELS = {
  /** Cheap + fast: transcript analysis, memory extraction, consolidation. */
  fast: process.env.GEMINI_FAST_MODEL || "gemini-flash-lite-latest",
  /** Stronger reasoning: grounded web search (lib/search.ts). */
  agent: process.env.GEMINI_AGENT_MODEL || "gemini-flash-latest",
  /** 768-dim text embeddings for memory recall. */
  embedding: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
};

export const EMBEDDING_DIM = 768;

const globalAI = globalThis as typeof globalThis & {
  __auralGenAI?: GoogleGenAI;
};

/** Shared client, or null when GEMINI_API_KEY is not configured. */
export function getAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return (globalAI.__auralGenAI ??= new GoogleGenAI({ apiKey }));
}

/** True for quota/rate-limit errors, which deserve one gentle retry. */
export function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
}

/** True when a DAILY free-tier cap is hit — waiting won't help until tomorrow. */
export function isDailyCap(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return isRateLimit(err) && msg.includes("PerDay");
}

/** Human-readable version of an API error for the UI. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isDailyCap(err)) {
    return "The Gemini free-tier DAILY quota for this model is used up. It resets tomorrow — or add billing to your API key (see README: a paid key is strongly recommended).";
  }
  if (isRateLimit(err)) {
    return "The Gemini API is rate-limiting this key (free-tier per-minute quota). Try again in a minute, or add billing to your API key.";
  }
  return msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
}

/**
 * How long Google asks us to wait, parsed from the 429 payload
 * ("Please retry in 14.0086s" / RetryInfo retryDelay). Capped at 60s.
 */
export function retryDelayMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m =
    msg.match(/retry in ([\d.]+)s/i) ?? msg.match(/"retryDelay":"([\d.]+)s"/);
  const secs = m ? parseFloat(m[1]) : 5;
  return Math.min(Math.ceil(secs + 1) * 1000, 60_000);
}

/** Run fn, retrying once after a delay if the API rate-limits us. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    await new Promise((r) => setTimeout(r, retryDelayMs(err)));
    return fn();
  }
}
