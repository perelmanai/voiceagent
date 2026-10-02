export type RelayLine = {
  text: string;
  ts: number;
  type?: "activity" | "partial" | "final" | "stop" | "end";
  utteranceId?: string;
  sequence?: number;
};

/** Accept old {code,text} clients while validating the live speech protocol. */
export function parseSpeechPayload(body: unknown, now = Date.now()): { code: string; line: RelayLine } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (typeof value.code !== "string" || typeof value.text !== "string") return null;
  const code = value.code.trim().toUpperCase();
  const text = value.text.trim();
  if (!/^[A-Z0-9]{1,32}$/.test(code) || text.length > 12000) return null;
  if (value.type === undefined) return text ? { code, line: { text, ts: now } } : null;
  if (!["activity", "partial", "final", "stop", "end"].includes(value.type as string)) return null;
  if (typeof value.utteranceId !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(value.utteranceId)) return null;
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
  if ((value.type === "partial" || value.type === "final") && !text) return null;
  return {
    code,
    line: {
      text, ts: now,
      type: value.type as RelayLine["type"],
      utteranceId: value.utteranceId,
      sequence: value.sequence,
    },
  };
}
